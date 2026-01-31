const http = require('http');
const WebSocket = require('ws');
const https = require('https');
const { randomBytes } = require('crypto');
const { parse } = require('url');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

console.log('🚀 Starting Realtime Voice Server...');

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not configured');
  process.exit(1);
}

// Get ephemeral token
async function getRealtimeToken() {
  return new Promise((resolve, reject) => {
    console.log('🔑 Requesting ephemeral token...');
    
    const postData = JSON.stringify({
      model: 'gpt-4o-realtime-preview',
      voice: 'alloy'
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/realtime/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'OpenAI-Beta': 'realtime=v1'
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          if (json.client_secret?.value) {
            console.log('✅ Ephemeral token received');
            resolve(json.client_secret.value);
          } else {
            reject(new Error('No client_secret in response'));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(postData);
    req.end();
  });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } else if (parsedUrl.pathname === '/upload') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { filename, contentType, text, content } = data;
          
          if (!filename) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing filename' }));
            return;
          }
          
          const extractedText = text || content || '';
          const fileId = randomBytes(8).toString('hex');
          
          console.log(`📤 File uploaded: ${filename} (${extractedText.length} chars)`);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            filename: filename,
            text: extractedText,
            contentType: contentType || 'application/octet-stream',
            id: fileId,
            message: 'File content extracted as text'
          }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Realtime Voice Server\n');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', async (clientSocket, req) => {
  const clientId = randomBytes(4).toString('hex');
  console.log(`\n📞 [${clientId}] New connection`);
  
  let openaiWs = null;
  let isMuted = false;
  let isReady = false;
  let isResponding = false;
  let messageQueue = [];
  
  try {
    const token = await getRealtimeToken();
    const openaiUrl = 'wss://api.openai.com/v1/realtime';
    
    console.log(`🔌 [${clientId}] Connecting to OpenAI...`);
    
    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    
    openaiWs.on('open', () => {
      console.log(`✅ [${clientId}] Connected to OpenAI`);
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are Life, a friendly AI voice assistant. Keep responses concise and conversational. You cannot access external links or files - if mentioned, ask the user to describe the content.',
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1',
            language: 'en'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 1200
          },
          temperature: 0.8,
          tools: []
        }
      }));
      
      clientSocket.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to OpenAI',
        language: 'en',
        voice: 'alloy',
        capabilities: {
          files: 'text_only',
          note: 'Files must be uploaded and converted to text first'
        }
      }));
    });
    
    openaiWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'session.updated') {
          console.log(`✅ [${clientId}] Session ready - VAD configured`);
          isReady = true;
          
          while (messageQueue.length > 0) {
            const queuedMsg = messageQueue.shift();
            console.log(`⏳ [${clientId}] Processing queued: ${queuedMsg.type}`);
            handleClientMessage(queuedMsg);
          }
          
          setTimeout(() => {
            if (openaiWs.readyState === WebSocket.OPEN) {
              console.log(`👋 [${clientId}] Sending greeting...`);
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio']
                }
              }));
            }
          }, 500);
        }
        
        if (message.type === 'input_audio_buffer.speech_started') {
          console.log(`🎤 [${clientId}] Speech started`);
          clientSocket.send(JSON.stringify({ type: 'vad_start' }));
        }
        
        if (message.type === 'input_audio_buffer.speech_stopped') {
          console.log(`🎤 [${clientId}] Speech stopped`);
          clientSocket.send(JSON.stringify({ type: 'vad_stop' }));
        }
        
        if (message.type === 'response.audio.delta' && message.delta) {
          console.log(`🎵 [${clientId}] Audio chunk: ${message.delta.length} bytes`);
          clientSocket.send(JSON.stringify({
            type: 'audio',
            data: message.delta,
            format: 'pcm16'
          }));
        }
        
        if (message.type === 'response.created') {
          isResponding = true;
          console.log(`▶️ [${clientId}] Response started`);
        }
        
        if (message.type === 'response.done') {
          isResponding = false;
          console.log(`⏹️ [${clientId}] Response completed - waiting for user...`);
        }
        
        if (message.type === 'response.cancelled') {
          isResponding = false;
          console.log(`⏹️ [${clientId}] Response cancelled`);
        }
        
        if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`📝 [${clientId}] User said: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: message.transcript,
            language: 'en'
          }));
        }
        
        if (message.type === 'response.audio_transcript.done') {
          console.log(`🤖 [${clientId}] AI said: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'assistant',
            text: message.transcript,
            language: 'en'
          }));
        }
        
        if (message.type === 'response.audio_transcript.delta') {
          console.log(`🗣️ [${clientId}] AI speaking chunk: "${message.delta}"`);
        }
        
        if (message.type === 'error') {
          console.error(`❌ [${clientId}] OpenAI error:`, message.error);
          isResponding = false;
          clientSocket.send(JSON.stringify({
            type: 'error',
            message: message.error?.message || 'Unknown error'
          }));
        }
        
      } catch (error) {
        console.error(`❌ [${clientId}] Parse error:`, error);
      }
    });
    
    openaiWs.on('error', (error) => {
      console.error(`❌ [${clientId}] OpenAI error:`, error.message);
    });
    
    openaiWs.on('close', () => {
      console.log(`🔴 [${clientId}] OpenAI connection closed`);
      isReady = false;
      isResponding = false;
      clientSocket.close();
    });
    
  } catch (error) {
    console.error(`❌ [${clientId}] Setup failed:`, error);
    clientSocket.send(JSON.stringify({
      type: 'error',
      message: `Setup failed: ${error.message}`
    }));
    return;
  }
  
  function handleClientMessage(message) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.error(`❌ [${clientId}] OpenAI not connected`);
      return;
    }
    
    if (message.type === 'mute') {
      isMuted = true;
      console.log(`🔇 [${clientId}] Muted`);
      clientSocket.send(JSON.stringify({ type: 'muted', muted: true }));
      return;
    }
    
    if (message.type === 'unmute') {
      isMuted = false;
      console.log(`🔊 [${clientId}] Unmuted`);
      clientSocket.send(JSON.stringify({ type: 'muted', muted: false }));
      return;
    }
    
    if (message.type === 'text_message' && message.text) {
      console.log(`💬 [${clientId}] Text: ${message.text.substring(0, 100)}...`);
      console.log(`📊 [${clientId}] isResponding=${isResponding}, isReady=${isReady}, wsState=${openaiWs.readyState}`);
      
      if (isResponding) {
        console.log(`⏳ [${clientId}] Skipping - response in progress`);
        clientSocket.send(JSON.stringify({
          type: 'warning',
          message: 'Please wait for the current response to finish'
        }));
        return;
      }
      
      console.log(`🧹 [${clientId}] Clearing audio buffer...`);
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      
      let fullText = message.text;
      
      if (message.files && message.files.length > 0) {
        console.log(`📎 [${clientId}] Processing ${message.files.length} file(s) as text`);
        
        for (const file of message.files) {
          if (file.text || file.content) {
            const fileText = file.text || file.content || '';
            const fileName = file.name || 'File';
            fullText += `\n\n[Content from ${fileName}]:\n${fileText}`;
            console.log(`📝 [${clientId}] Added text from: ${fileName} (${fileText.length} chars)`);
          } else if (file.url) {
            fullText += `\n\n[Note: I cannot access the file at ${file.url}. Please describe what's in the file.]`;
            console.log(`🔗 [${clientId}] URL file referenced: ${file.name || file.url}`);
          }
        }
      }
      
      console.log(`📝 [${clientId}] Creating conversation item with text: "${fullText.substring(0, 50)}..."`);
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: fullText }]
        }
      }));
      
      setTimeout(() => {
        console.log(`⏰ [${clientId}] Timeout fired - wsState=${openaiWs.readyState}, isResponding=${isResponding}`);
        if (openaiWs.readyState === WebSocket.OPEN && !isResponding) {
          console.log(`🚀 [${clientId}] Sending response.create to OpenAI...`);
          openaiWs.send(JSON.stringify({ 
            type: 'response.create',
            response: {
              modalities: ['text', 'audio']
            }
          }));
          console.log(`✅ [${clientId}] response.create sent`);
        } else {
          console.log(`❌ [${clientId}] Cannot send response.create - wsState=${openaiWs.readyState}, isResponding=${isResponding}`);
        }
      }, 200);
      
      clientSocket.send(JSON.stringify({
        type: 'transcript',
        role: 'user',
        text: message.text,
        language: 'en',
        files_attached: message.files ? message.files.length : 0
      }));
      
      return;
    }
    
    if (message.type === 'file_text' && message.text) {
      console.log(`📄 [${clientId}] File text content: ${message.text.substring(0, 100)}...`);
      
      if (isResponding) {
        console.log(`⏳ [${clientId}] Skipping - response in progress`);
        return;
      }
      
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: message.text }]
        }
      }));
      
      setTimeout(() => {
        if (openaiWs.readyState === WebSocket.OPEN && !isResponding) {
          openaiWs.send(JSON.stringify({ 
            type: 'response.create',
            response: {
              modalities: ['text', 'audio']
            }
          }));
        }
      }, 200);
      
      return;
    }
    
    if (message.type === 'audio' && message.data && !isMuted) {
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: message.data
      }));
      return;
    }
    
    if (message.type === 'cancel') {
      console.log(`⏹️ [${clientId}] Cancelling current response`);
      if (isResponding) {
        openaiWs.send(JSON.stringify({
          type: 'response.cancel'
        }));
      }
      return;
    }
    
    if (message.type === 'set_language' && message.language) {
      console.log(`🌐 [${clientId}] Language change requested: ${message.language}`);
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_transcription: {
            model: 'whisper-1',
            language: message.language
          }
        }
      }));
      
      clientSocket.send(JSON.stringify({
        type: 'language_set',
        language: message.language
      }));
      return;
    }
    
    if (message.type === 'clear') {
      console.log(`🧹 [${clientId}] Clearing conversation`);
      
      openaiWs.send(JSON.stringify({
        type: 'conversation.clear'
      }));
      
      clientSocket.send(JSON.stringify({
        type: 'conversation_cleared'
      }));
      return;
    }
  }
  
  clientSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (isReady) {
        handleClientMessage(message);
      } else {
        if (message.type === 'audio') {
          console.log(`🎤 [${clientId}] Buffering audio (not ready yet)`);
        } else {
          messageQueue.push(message);
          console.log(`⏳ [${clientId}] Queued: ${message.type}`);
        }
      }
      
    } catch (error) {
      console.error(`❌ [${clientId}] Parse error:`, error);
    }
  });
  
  clientSocket.on('close', () => {
    console.log(`🔴 [${clientId}] Client disconnected`);
    if (openaiWs) openaiWs.close();
  });
  
  clientSocket.on('error', (error) => {
    console.error(`❌ [${clientId}] Client error:`, error);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`🔗 WebSocket ready at ws://localhost:${PORT}`);
  console.log(`🌐 Default language: English (en)`);
  console.log(`🎙️  Voice: alloy`);
  console.log(`📤 File upload endpoint: http://localhost:${PORT}/upload`);
  console.log(`\n⚠️  IMPORTANT: OpenAI Realtime API cannot access external files.`);
  console.log(`📝 Files must be converted to text on the client side first.`);
  console.log(`\n🎤 Ready for voice conversations...\n`);
});

process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
