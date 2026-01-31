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
    // Simple file upload handler for demo purposes
    // In production, use proper file storage like S3, Cloudinary, etc.
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { filename, contentType, base64Data } = data;
          
          if (!filename || !base64Data) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing filename or data' }));
            return;
          }
          
          // For demo, we'll just echo back a mock URL
          // In production, upload to actual storage and return real URL
          const fileId = randomBytes(8).toString('hex');
          const mockUrl = `https://api.example.com/uploads/${fileId}/${encodeURIComponent(filename)}`;
          
          console.log(`📤 Mock upload: ${filename} -> ${mockUrl}`);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            filename: filename,
            url: mockUrl,
            contentType: contentType || 'application/octet-stream',
            id: fileId
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
      
      // Configure session to support all modalities including images
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are a helpful, friendly AI assistant. Always respond in English. Keep responses concise and natural.',
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
            silence_duration_ms: 500
          },
          temperature: 0.8,
          tools: [] // Ensure tools are properly configured if needed
        }
      }));
      
      clientSocket.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to OpenAI',
        language: 'en',
        voice: 'alloy'
      }));
    });
    
    openaiWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Session ready - process queue
        if (message.type === 'session.updated') {
          console.log(`✅ [${clientId}] Session ready (English language mode)`);
          isReady = true;
          
          // Process queued messages
          while (messageQueue.length > 0) {
            const queuedMsg = messageQueue.shift();
            console.log(`⏳ [${clientId}] Processing queued: ${queuedMsg.type}`);
            handleClientMessage(queuedMsg);
          }
          
          // Send English greeting
          setTimeout(() => {
            if (openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio'],
                  instructions: 'Greet the user in English. Welcome them to the conversation.'
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
        
        // Transcriptions
        if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`📝 [${clientId}] User (English): ${message.transcript}`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: message.transcript,
            language: 'en'
          }));
        }
        
        if (message.type === 'response.audio_transcript.done') {
          console.log(`🤖 [${clientId}] AI (English): ${message.transcript}`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'assistant',
            text: message.transcript,
            language: 'en'
          }));
        }
        
        // Handle tool calls if needed (for image analysis)
        if (message.type === 'conversation.item.create' && message.item?.role === 'assistant') {
          console.log(`🤖 [${clientId}] Assistant message created`);
        }
        
        // Errors
        if (message.type === 'error') {
          console.error(`❌ [${clientId}] OpenAI error:`, message.error);
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
    
    // Text messages with optional files
    if (message.type === 'text_message' && message.text) {
      console.log(`💬 [${clientId}] Text (English): ${message.text.substring(0, 100)}...`);
      
      // Clear audio buffer first
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      
      // Create content array starting with text
      const content = [{ type: 'input_text', text: message.text }];
      
      // Append files if provided
      if (message.files && message.files.length > 0) {
        console.log(`📎 [${clientId}] Processing ${message.files.length} file(s)`);
        
        for (const file of message.files) {
          // Handle images via URL
          if (file.url && (file.type?.startsWith('image/') || file.mimeType?.startsWith('image/'))) {
            content.push({
              type: 'input_image',
              image_url: file.url
            });
            console.log(`🖼️  [${clientId}] Added image: ${file.name || 'unnamed'}`);
          }
          // Handle audio via URL
          else if (file.url && (file.type?.startsWith('audio/') || file.mimeType?.startsWith('audio/'))) {
            content.push({
              type: 'input_audio',
              audio_url: file.url
            });
            console.log(`🎵 [${clientId}] Added audio: ${file.name || 'unnamed'}`);
          }
          // Handle documents via URL
          else if (file.url) {
            content.push({
              type: 'input_document',
              document_url: file.url
            });
            console.log(`📄 [${clientId}] Added document: ${file.name || 'unnamed'}`);
          }
          // Handle text content directly
          else if (file.content || file.text) {
            const fileText = file.content || file.text;
            const fileName = file.name || 'File';
            content.push({
              type: 'input_text',
              text: `[${fileName}]:\n${fileText}`
            });
            console.log(`📝 [${clientId}] Added file content: ${fileName}`);
          }
          // Handle base64 images
          else if (file.base64 && file.type?.startsWith('image/')) {
            // Note: OpenAI Realtime API might not support base64 directly
            // You'd need to upload to a URL first
            console.warn(`⚠️ [${clientId}] Base64 images need to be uploaded first`);
            clientSocket.send(JSON.stringify({
              type: 'error',
              message: 'Base64 images need to be uploaded to a URL first'
            }));
          }
        }
      }
      
      // Create conversation item with all content
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: content
        }
      }));
      
      // Trigger response
      setTimeout(() => {
        openaiWs.send(JSON.stringify({ 
          type: 'response.create',
          response: {
            modalities: ['text', 'audio']
          }
        }));
      }, 100);
      
      // Echo to client
      clientSocket.send(JSON.stringify({
        type: 'transcript',
        role: 'user',
        text: message.text,
        language: 'en'
      }));
      
      return;
    }
    
    // Standalone attachment
    if (message.type === 'attachment') {
      console.log(`📎 [${clientId}] Processing attachment`);
      
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      
      const content = [];
      
      // Handle different attachment types
      if (message.url) {
        if (message.type && message.type.startsWith('image/') || message.mimeType?.startsWith('image/')) {
          content.push({
            type: 'input_image',
            image_url: message.url
          });
          console.log(`🖼️  [${clientId}] Processing image: ${message.filename || 'unnamed'}`);
        }
        else if (message.type && message.type.startsWith('audio/') || message.mimeType?.startsWith('audio/')) {
          content.push({
            type: 'input_audio',
            audio_url: message.url
          });
          console.log(`🎵 [${clientId}] Processing audio: ${message.filename || 'unnamed'}`);
        }
        else {
          content.push({
            type: 'input_document',
            document_url: message.url
          });
          console.log(`📄 [${clientId}] Processing document: ${message.filename || 'unnamed'}`);
        }
      }
      else if (message.content || message.text) {
        const fileContent = message.content || message.text || '';
        const fileName = message.filename || 'Attachment';
        content.push({
          type: 'input_text',
          text: `${fileName}:\n${fileContent}`
        });
        console.log(`📝 [${clientId}] Processing text attachment: ${fileName}`);
      }
      else if (message.base64 && (message.type?.startsWith('image/') || message.mimeType?.startsWith('image/'))) {
        console.warn(`⚠️ [${clientId}] Base64 images need URL upload first`);
        clientSocket.send(JSON.stringify({
          type: 'error',
          message: 'Please upload the image first using /upload endpoint'
        }));
        return;
      }
      
      if (content.length === 0) {
        console.error(`❌ [${clientId}] No valid content in attachment`);
        clientSocket.send(JSON.stringify({
          type: 'error',
          message: 'Attachment has no valid content'
        }));
        return;
      }
      
      // Create conversation item
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: content
        }
      }));
      
      // Trigger response
      setTimeout(() => {
        openaiWs.send(JSON.stringify({ 
          type: 'response.create',
          response: {
            modalities: ['text', 'audio']
          }
        }));
      }, 100);
      
      clientSocket.send(JSON.stringify({
        type: 'attachment_received',
        filename: message.filename || 'attachment',
        language: 'en'
      }));
      
      return;
    }
    
    // Audio streaming (only if not muted)
    if (message.type === 'audio' && message.data && !isMuted) {
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: message.data
      }));
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
      
      if (isReady) {
        handleClientMessage(message);
      } else {
        // Queue until ready
        messageQueue.push(message);
        console.log(`⏳ [${clientId}] Queued: ${message.type}`);
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
  console.log('\n🎤 Ready for voice conversations...\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
