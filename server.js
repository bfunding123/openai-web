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
    // Simple file upload handler that extracts text
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
          
          // Extract text from the file
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
      
      // Configure session with LONGER silence timeout for phone calls
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
        
        // LOG EVERY SINGLE MESSAGE FOR DEBUGGING
        if (!['response.audio.delta'].includes(message.type)) {
          console.log(`🔵 [${clientId}] OpenAI message type: ${message.type}`);
          console.log(`📋 [${clientId}] Full message:`, JSON.stringify(message, null, 2));
        }
        
        // Session ready - process queue
        if (message.type === 'session.updated') {
          console.log(`✅ [${clientId}] Session ready - VAD configured with 5s silence timeout`);
          isReady = true;
          
          // Process queued messages
          while (messageQueue.length > 0) {
            const queuedMsg = messageQueue.shift();
            console.log(`⏳ [${clientId}] Processing queued: ${queuedMsg.type}`);
            handleClientMessage(queuedMsg);
          }
          
          // Send greeting
          setTimeout(() => {
            if (openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio']
                }
              }));
            }
          }, 500);
        }
        
        // VAD events
        if (message.type === 'input_audio_buffer.speech_started') {
          console.log(`🎤 [${clientId}] Speech started`);
          clientSocket.send(JSON.stringify({ type: 'vad_start' }));
        }
        
        if (message.type === 'input_audio_buffer.speech_stopped') {
          console.log(`🎤 [${clientId}] Speech stopped`);
          clientSocket.send(JSON.stringify({ type: 'vad_stop' }));
        }
        
        // Audio output
        if (message.type === 'response.audio.delta' && message.delta) {
          clientSocket.send(JSON.stringify({
            type: 'audio',
            data: message.delta,
            format: 'pcm16'
          }));
        }
        
        // Response started
        if (message.type === 'response.created') {
          isResponding = true;
          console.log(`▶️ [${clientId}] Response started`);
        }
        
        // Response done
        if (message.type === 'response.done') {
          isResponding = false;
          console.log(`⏹️ [${clientId}] Response completed - waiting for user...`);
        }
        
        // Response cancelled
        if (message.type === 'response.cancelled') {
          isResponding = false;
          console.log(`⏹️ [${clientId}] Response cancelled`);
        }
        
        // Transcriptions
        if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`📝 [${clientId}] User said: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: message.transcript,
            language: 'en'
          }));
        }
        
        // Transcription failures
        if (message.type === 'conversation.item.input_audio_transcription.failed') {
          console.error(`❌❌❌ [${clientId}] TRANSCRIPTION FAILED ❌❌❌`);
          console.error(`Full error object:`, JSON.stringify(message, null, 2));
          console.error(`Error details:`, {
            item_id: message.item_id,
            content_index: message.content_index,
            error: message.error
          });
          clientSocket.send(JSON.stringify({
            type: 'error',
            message: `Transcription failed: ${message.error?.message || 'Unknown error'}`
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
        
        // Errors
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
  
  // Handle client messages
  function handleClientMessage(message) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.error(`❌ [${clientId}] OpenAI not connected`);
      return;
    }
    
    // Mute/Unmute
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
    
    // Text messages with optional text content from files
    if (message.type === 'text_message' && message.text) {
      console.log(`💬 [${clientId}] Text: ${message.text.substring(0, 100)}...`);
      console.log(`📊 [${clientId}] isResponding=${isResponding}, isReady=${isReady}, wsState=${openaiWs.readyState}`);
      
      // Don't send if already responding
      if (isResponding) {
        console.log(`⏳ [${clientId}] Skipping - response in progress`);
        clientSocket.send(JSON.stringify({
          type: 'warning',
          message: 'Please wait for the current response to finish'
        }));
        return;
      }
      
      // Clear audio buffer first
      console.log(`🧹 [${clientId}] Clearing audio buffer...`);
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      
      // Start building the message text
      let fullText = message.text;
      
      // Append file text content if provided
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
      
      // Create conversation item with text content only
      console.log(`📝 [${clientId}] Creating conversation item with text: "${fullText.substring(0, 50)}..."`);
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: fullText }]
        }
      }));
      
      // Wait a bit before triggering response
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
      
      // Echo to client
      clientSocket.send(JSON.stringify({
        type: 'transcript',
        role: 'user',
        text: message.text,
        language: 'en',
        files_attached: message.files ? message.files.length : 0
      }));
      
      return;
    }
    
    // Process extracted text from files
    if (message.type === 'file_text' && message.text) {
      console.log(`📄 [${clientId}] File text content: ${message.text.substring(0, 100)}...`);
      
      if (isResponding) {
        console.log(`⏳ [${clientId}] Skipping - response in progress`);
        return;
      }
      
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      
      // Create conversation item with extracted text
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
    
    // Audio streaming (only if not muted)
    if (message.type === 'audio' && message.data && !isMuted) {
      console.log(`🎤 [${clientId}] Sending audio to OpenAI: ${message.data.length} bytes, muted=${isMuted}`);
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: message.data
      }));
      return;
    }
    
    // Log if audio was skipped
    if (message.type === 'audio' && !message.data) {
      console.log(`⚠️ [${clientId}] Audio message received but no data`);
    }
    if (message.type === 'audio' && isMuted) {
      console.log(`🔇 [${clientId}] Audio skipped - muted`);
    }
    
    // Cancel current response
    if (message.type === 'cancel') {
      console.log(`⏹️ [${clientId}] Cancelling current response`);
      if (isResponding) {
        openaiWs.send(JSON.stringify({
          type: 'response.cancel'
        }));
      }
      return;
    }
    
    // Language change request
    if (message.type === 'set_language' && message.language) {
      console.log(`🌐 [${clientId}] Language change requested: ${message.language}`);
      
      // Update session language
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
    
    // Clear conversation
    if (message.type === 'clear') {
      console.log(`🧹 [${clientId}] Clearing conversation`);
      
      // Clear all conversation items
      openaiWs.send(JSON.stringify({
        type: 'conversation.clear'
      }));
      
      clientSocket.send(JSON.stringify({
        type: 'conversation_cleared'
      }));
      return;
    }
  }
  
  // Client message handler
  clientSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`📥 [${clientId}] Received message type: ${message.type}, isReady: ${isReady}`);
      
      if (isReady) {
        console.log(`✅ [${clientId}] Session ready - handling message directly`);
        handleClientMessage(message);
      } else {
        // Queue until ready (except audio which we can buffer)
        if (message.type === 'audio') {
          // Buffer audio in WebSocket connection itself
          console.log(`🎤 [${clientId}] Buffering audio (not ready yet)`);
        } else {
          messageQueue.push(message);
          console.log(`⏳ [${clientId}] Queued: ${message.type} (queue size: ${messageQueue.length})`);
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

// Start server
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
