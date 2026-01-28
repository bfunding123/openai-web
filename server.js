const http = require('http');
const WebSocket = require('ws');
const https = require('https');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

console.log('🔑 API Key present:', !!OPENAI_API_KEY);

// Get ephemeral token from OpenAI
async function getEphemeralToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'gpt-4o-realtime-preview-2024-10-01',
      voice: 'alloy'
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/realtime/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(body);
          resolve(json.client_secret.value);
        } else {
          reject(new Error(`Token error: ${res.statusCode} ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Voice Server Running');
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', async (clientWs) => {
  console.log('📞 Client connected');
  
  let openaiWs = null;
  
  try {
    // Get token
    const token = await getEphemeralToken();
    console.log('✅ Got token');
    
    // Connect to OpenAI
    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );
    
    openaiWs.on('open', () => {
      console.log('✅ OpenAI connected');
      
      // Configure session
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are a helpful AI assistant. Keep responses brief and conversational.',
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      }));
    });
    
    openaiWs.on('message', (data) => {
      const msg = JSON.parse(data);
      
      console.log('📨', msg.type);
      
      // Session ready - send greeting
      if (msg.type === 'session.updated') {
        setTimeout(() => {
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio'],
              instructions: 'Say "Hi! I\'m listening."'
            }
          }));
        }, 500);
      }
      
      // Forward audio to client
      if (msg.type === 'response.audio.delta' && msg.delta) {
        clientWs.send(JSON.stringify({
          type: 'audio',
          data: msg.delta
        }));
      }
      
      // Forward transcripts
      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        console.log('👤 User:', msg.transcript);
        clientWs.send(JSON.stringify({
          type: 'transcript',
          role: 'user',
          text: msg.transcript
        }));
      }
      
      if (msg.type === 'response.audio_transcript.done') {
        console.log('🤖 AI:', msg.transcript);
        clientWs.send(JSON.stringify({
          type: 'transcript',
          role: 'assistant',
          text: msg.transcript
        }));
      }
    });
    
    openaiWs.on('error', (err) => {
      console.error('❌ OpenAI error:', err.message);
    });
    
    openaiWs.on('close', () => {
      console.log('🔴 OpenAI closed');
      clientWs.close();
    });
    
    // Forward client audio to OpenAI
    clientWs.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'audio' && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.data
        }));
      }
    });
    
    clientWs.on('close', () => {
      console.log('🔴 Client closed');
      if (openaiWs) openaiWs.close();
    });
    
  } catch (error) {
    console.error('❌ Setup error:', error.message);
    clientWs.close();
  }
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});