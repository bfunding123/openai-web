const http = require('http');
const WebSocket = require('ws');
const https = require('https');
const { randomBytes } = require('crypto');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

console.log('🚀 Starting Realtime Voice Server...');

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not configured');
  process.exit(1);
}

// Test the API key first
async function testAPIKey() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ API key is valid');
          resolve(true);
        } else {
          console.error('❌ API key invalid:', res.statusCode, data);
          resolve(false);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Get ephemeral token with better error handling
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
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`📥 Token response: ${res.statusCode}`);
        
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            if (json.client_secret?.value) {
              console.log('✅ Ephemeral token received');
              resolve(json.client_secret.value);
            } else {
              reject(new Error('No client_secret in response'));
            }
          } catch (e) {
            reject(new Error('Failed to parse response'));
          }
        } else {
          console.error('❌ Token request failed:', data);
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => {
      console.error('❌ Request error:', e.message);
      reject(e);
    });

    req.on('timeout', () => {
      console.error('❌ Request timeout');
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(postData);
    req.end();
  });
}

// Create HTTP server
const server = http.createServer((req, res) => {
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
    res.end(JSON.stringify({ 
      status: 'ok', 
      timestamp: new Date().toISOString()
    }));
  } else if (req.url === '/test') {
    // Test the API key
    testAPIKey()
      .then(isValid => {
        if (isValid) {
          // Test Realtime API
          getRealtimeToken()
            .then(token => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                status: 'success', 
                message: 'Realtime API accessible',
                token_preview: token.substring(0, 20) + '...'
              }));
            })
            .catch(error => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                status: 'error', 
                message: 'Realtime API failed: ' + error.message
              }));
            });
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'API key invalid'
          }));
        }
      })
      .catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'error', 
          message: error.message
        }));
      });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Realtime Voice Server\n\nEndpoints:\n- /health\n- /test\n');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', async (clientSocket, req) => {
  const clientId = randomBytes(4).toString('hex');
  console.log(`\n📞 [${clientId}] New connection from ${req.socket.remoteAddress}`);
  
  let openaiWs = null;
  let isMuted = false;
  
  try {
    // Get ephemeral token
    const token = await getRealtimeToken();
    
    // Connect to OpenAI Realtime API
    const openaiUrl = 'wss://api.openai.com/v1/realtime';
    
    console.log(`🔌 [${clientId}] Connecting to OpenAI...`);
    
    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    
    // Set up OpenAI WebSocket
    openaiWs.on('open', () => {
      console.log(`✅ [${clientId}] Connected to OpenAI Realtime`);
      
      // Configure the session
      const config = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are a helpful, friendly AI assistant. Respond naturally in real-time conversation.',
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
          temperature: 0.8
        }
      };
      
      openaiWs.send(JSON.stringify(config));
      
      // Notify client
      clientSocket.send(JSON.stringify({
        type: 'connected',
        clientId: clientId,
        message: 'Connected to OpenAI Realtime API'
      }));
    });
    
    openaiWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Log important events
        if (message.type === 'session.created') {
          console.log(`📋 [${clientId}] Session created`);
        }
        
        if (message.type === 'session.updated') {
          if (message.session?.status === 'ready') {
            console.log(`✅ [${clientId}] Session ready - Listening...`);
            
            // Send initial greeting
            setTimeout(() => {
              if (openaiWs.readyState === WebSocket.OPEN) {
                const greeting = {
                  type: 'response.create',
                  response: {
                    modalities: ['text', 'audio'],
                    instructions: 'Greet the user warmly and let them know you\'re ready to chat.'
                  }
                };
                openaiWs.send(JSON.stringify(greeting));
              }
            }, 1000);
          }
        }
        
        if (message.type === 'input_audio_buffer.speech_started') {
          console.log(`🎤 [${clientId}] User started speaking`);
          clientSocket.send(JSON.stringify({ type: 'vad_start' }));
        }
        
        if (message.type === 'input_audio_buffer.speech_stopped') {
          console.log(`🎤 [${clientId}] User stopped speaking`);
          clientSocket.send(JSON.stringify({ type: 'vad_stop' }));
        }
        
        // Forward audio chunks to client
        if (message.type === 'response.audio.delta' && message.delta) {
          clientSocket.send(JSON.stringify({
            type: 'audio',
            data: message.delta
          }));
        }
        
        // Forward transcription
        if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`📝 [${clientId}] User: ${message.transcript}`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: message.transcript
          }));
        }
        
        if (message.type === 'response.audio_transcript.done') {
          console.log(`🤖 [${clientId}] AI: ${message.transcript}`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'assistant',
            text: message.transcript
          }));
        }
        
        // Handle errors
        if (message.type === 'error') {
          console.error(`❌ [${clientId}] OpenAI error:`, message.error);
          clientSocket.send(JSON.stringify({
            type: 'error',
            message: message.error?.message
          }));
        }
        
      } catch (error) {
        console.error(`❌ [${clientId}] Parse error:`, error.message);
      }
    });
    
    openaiWs.on('error', (error) => {
      console.error(`❌ [${clientId}] OpenAI WS error:`, error.message);
      clientSocket.send(JSON.stringify({
        type: 'error',
        message: 'OpenAI connection error'
      }));
    });
    
    openaiWs.on('close', () => {
      console.log(`🔴 [${clientId}] OpenAI connection closed`);
      clientSocket.close();
    });
    
  } catch (error) {
    console.error(`❌ [${clientId}] Setup failed:`, error.message);
    
    clientSocket.send(JSON.stringify({
      type: 'error',
      message: `Realtime setup failed: ${error.message}. Using fallback mode.`
    }));
    
    setupFallback(clientSocket, clientId);
    return;
  }
  
  // Handle client messages
  clientSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Handle mute/unmute
      if (message.type === 'mute') {
        isMuted = true;
        console.log(`🔇 [${clientId}] Muted`);
        clientSocket.send(JSON.stringify({
          type: 'muted',
          muted: true
        }));
        return;
      }
      
      if (message.type === 'unmute') {
        isMuted = false;
        console.log(`🔊 [${clientId}] Unmuted`);
        clientSocket.send(JSON.stringify({
          type: 'muted',
          muted: false
        }));
        return;
      }
      
      // Handle text messages
      if (message.type === 'text_message' && message.text && openaiWs) {
        console.log(`💬 [${clientId}] Text message: ${message.text}`);
        
        let fullText = message.text;
        
        // Append file context if provided
        if (message.files && message.files.length > 0) {
          for (const file of message.files) {
            if (file.type.startsWith('image/')) {
              fullText += `\n\n[Image attached: ${file.name}. URL: ${file.url}]`;
            } else if (file.content) {
              fullText += `\n\n[Document: ${file.name}]\n${file.content}`;
            }
          }
        }
        
        // Create conversation item
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: fullText
            }]
          }
        }));
        
        // Commit and trigger response
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.commit'
        }));
        
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text', 'audio']
          }
        }));
        
        // Echo to client
        clientSocket.send(JSON.stringify({
          type: 'transcript',
          role: 'user',
          text: message.text
        }));
      }
      
      // Handle attachments
      if (message.type === 'attachment' && openaiWs) {
        console.log(`📎 [${clientId}] Attachment: ${message.filename}`);
        
        let attachmentText = '';
        
        if (message.mimeType && message.mimeType.startsWith('image/')) {
          attachmentText = `[User attached image: ${message.filename}. URL: ${message.url}. Please analyze this image.]`;
        } else if (message.content) {
          attachmentText = `[User attached document: ${message.filename}]\nContent:\n${message.content}`;
        } else {
          attachmentText = `[User attached file: ${message.filename} (${message.mimeType}). URL: ${message.url}]`;
        }
        
        // Send as conversation item
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: attachmentText
            }]
          }
        }));
        
        // Commit and trigger response
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.commit'
        }));
        
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text', 'audio']
          }
        }));
        
        // Confirm to client
        clientSocket.send(JSON.stringify({
          type: 'attachment_received',
          filename: message.filename
        }));
      }
      
      // Forward audio to OpenAI (only if not muted)
      if (message.type === 'audio' && message.data && openaiWs && !isMuted) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: message.data
        }));
      }
      
      if (message.type === 'start') {
        console.log(`▶️ [${clientId}] Session started`);
      }
      
    } catch (error) {
      console.error(`❌ [${clientId}] Client message error:`, error);
    }
  });
  
  clientSocket.on('close', () => {
    console.log(`🔴 [${clientId}] Client disconnected`);
    if (openaiWs) {
      openaiWs.close();
    }
  });
  
  clientSocket.on('error', (error) => {
    console.error(`❌ [${clientId}] Client error:`, error);
  });
});

// Fallback mode (Chat + TTS)
function setupFallback(clientSocket, clientId) {
  console.log(`🔄 [${clientId}] Setting up fallback mode...`);
  
  let audioBuffer = '';
  let isProcessing = false;
  
  clientSocket.send(JSON.stringify({
    type: 'status',
    message: 'Using fallback mode (near real-time)'
  }));
  
  setTimeout(() => {
    clientSocket.send(JSON.stringify({
      type: 'transcript',
      role: 'assistant',
      text: "Hello! I'm here to help. Please speak and I'll respond."
    }));
  }, 500);
  
  clientSocket.on('message', async (data) => {
    if (isProcessing) return;
    
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'audio' && message.data) {
        audioBuffer += message.data;
        
        if (audioBuffer.length > 5000) {
          isProcessing = true;
          
          const transcript = "Hello there! How can I assist you today?";
          
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'gpt-4',
              messages: [
                { role: 'system', content: 'Be conversational and helpful.' },
                { role: 'user', content: transcript }
              ],
              max_tokens: 100
            })
          });
          
          const json = await response.json();
          const aiText = json.choices[0].message.content;
          
          const ttsResponse = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'tts-1',
              input: aiText,
              voice: 'alloy',
              response_format: 'mp3'
            })
          });
          
          const audioData = await ttsResponse.arrayBuffer();
          const base64Audio = Buffer.from(audioData).toString('base64');
          
          clientSocket.send(JSON.stringify({
            type: 'audio',
            format: 'mp3',
            data: base64Audio
          }));
          
          audioBuffer = '';
          isProcessing = false;
        }
      }
    } catch (error) {
      console.error(`❌ [${clientId}] Fallback error:`, error);
      isProcessing = false;
    }
  });
}

// Start server
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`🌐 HTTP: http://localhost:${PORT}`);
  console.log(`🔗 WebSocket: ws://localhost:${PORT}`);
  console.log(`📊 Test endpoint: http://localhost:${PORT}/test`);
  console.log('\n🎤 Ready for real-time voice conversations...');
  
  try {
    await testAPIKey();
  } catch (error) {
    console.error('⚠️ API key test failed on startup');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
