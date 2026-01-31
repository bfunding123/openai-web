// Production WebSocket Server for OpenAI Realtime API
// Handles ephemeral token generation and WebSocket proxying

const http = require('http');
const WebSocket = require('ws');
const https = require('https');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

console.log('🔑 OPENAI_API_KEY configured:', OPENAI_API_KEY ? 'YES' : 'NO');

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not configured');
  process.exit(1);
}

// Create ephemeral token for Realtime API
async function getRealtimeToken(voice = 'alloy') {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: 'gpt-4o-realtime-preview-2024-10-01',
      voice: voice
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/realtime/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log('📥 Token response status:', res.statusCode);
        console.log('📥 Token response body:', data);
        
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            console.log('✅ Got ephemeral token');
            resolve(json.client_secret.value);
          } catch (e) {
            console.error('❌ Failed to parse token response:', e.message);
            console.error('Response was:', data);
            reject(new Error('Failed to parse token response: ' + e.message));
          }
        } else {
          console.error('❌ Token request failed with status:', res.statusCode);
          console.error('❌ Error body:', data);
          reject(new Error(`Token request failed: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

// Create HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'voice-streaming' }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OpenAI Realtime Voice Server');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', async (clientSocket, req) => {
  console.log('📞 Client connected');
  
  // Parse user email and voice preference from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const userEmail = url.searchParams.get('user_email') || 'anonymous';
  const voicePreference = url.searchParams.get('voice') || 'alloy';
  const conversationId = url.searchParams.get('conversation_id') || null;
  console.log('👤 User:', userEmail);
  console.log('🎵 Voice:', voicePreference);
  console.log('💬 Conversation ID:', conversationId);
  
  let openaiWs = null;
  let sessionReady = false;
  let audioChunkCount = 0;
  let isMuted = false;
  
  try {
    // Get ephemeral token with user's voice preference
    console.log('🔑 Requesting ephemeral token...');
    const ephemeralToken = await getRealtimeToken(voicePreference);
    console.log('✅ Ephemeral token received');
    
    // Connect to OpenAI Realtime API with ephemeral token
    const openaiUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01`;
    
    console.log('🔌 Connecting to OpenAI Realtime API...');
    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        'Authorization': `Bearer ${ephemeralToken}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    
    // OpenAI WebSocket handlers
    openaiWs.on('open', () => {
      console.log('✅ Connected to OpenAI Realtime API');
      
      // Configure session - Use server VAD with longer silence timeout
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `You are Life, the AI life companion. Just "Life" - simple and personal. You say "Hey, I'm Life. What's up? How can I help you today?" regardless of voice choice.

You're warm, conversational, and remember everything about ${userEmail}.

YOUR ROLE:
- Personal AI companion who remembers and learns from every conversation
- Warm friend who checks in on goals, memories, and life progress
- Knowledgeable guide for the Life.AI platform features

LIFE.AI SUITE (15 AI Assistants):
1. Life.AI (You) - Main AI companion for life management, conversations, and guidance
2. Yili - Social media content creation genius and influencer assistant
3. Business in a Box - Complete business operations AI with CRM, deals pipeline, and task management
4. Marcus - Business strategy and growth advisor
5. Chef Antoine - Culinary expert and meal planning assistant
6. GPS Navigator - Advanced AI navigation with scenic routes and traffic intelligence
7. Fitness Coach - Personalized workout plans and health tracking
8. Worship Companion - Spiritual growth, Bible study, and faith journey support
9. Calendar AI - Intelligent scheduling and event management
10. Email Manager - Smart inbox organization and follow-up automation
11. Video Hub - Social media content creation and video generation
12. Journal AI - Reflective journaling with AI insights
13. Goal Tracker - SMART goal setting with AI-powered breakdowns
14. Memory Keeper - Contextual memory across all conversations
15. Life Balance Dashboard - Holistic life assessment and optimization

KEY FEATURES:
- Voice Chat (what you're using now!) with natural conversation
- Memory across sessions - I remember your preferences and history
- Google Calendar, Gmail, Tasks integration
- HubSpot CRM sync for businesses
- Proactive AI that checks in on goals and wellbeing
- WhatsApp integration for mobile access
- Multi-language support (English & Spanish)
- Real-time AI insights and recommendations

PERSONALITY:
- Warm and empathetic
- Professional yet friendly
- Proactive in suggesting helpful features
- Concise (1-3 sentences) unless asked for more detail
- Natural conversational style

IMPORTANT: After greeting, WAIT for the user to speak. Don't assume they hung up if there's silence. Be patient and let them take their time to respond.

When users ask about features, explain clearly and enthusiastically. When appropriate, guide them to specific assistants in the suite. Always remember context from the conversation.

User: ${userEmail}`,
          voice: voicePreference,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 3000  // 3 seconds - give user time to respond
          },
          temperature: 0.8,
          max_response_output_tokens: 4096
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
      console.log('📤 Session configuration sent with server VAD (3s silence timeout)');
      
      // Notify client
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({
          type: 'connection.established',
          status: 'connected'
        }));
      }
    });
    
    openaiWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Log ALL events for debugging
        console.log('📨 OpenAI Event:', message.type);
        
        // Session events
        if (message.type === 'session.created') {
          console.log('✅ Session created');
        } else if (message.type === 'session.updated') {
          console.log('✅ Session updated - VAD enabled, ready for conversation');
          sessionReady = true;
          
          // Send initial greeting AFTER session is ready
          setTimeout(() => {
            if (openaiWs.readyState === WebSocket.OPEN) {
              console.log('📤 Triggering greeting response...');
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio'],
                  instructions: 'Say "Hey, I\'m Life. What\'s up? How can I help you today?" in a casual, friendly tone. Then WAIT patiently for the user to respond - don\'t end the conversation if there\'s silence.'
                }
              }));
            }
          }, 100);
        }
        
        // VAD events
        else if (message.type === 'input_audio_buffer.speech_started') {
          console.log('🎤 User started speaking');
          audioChunkCount = 0;
        } else if (message.type === 'input_audio_buffer.speech_stopped') {
          console.log('🎤 User stopped speaking - VAD will auto-respond');
        } else if (message.type === 'input_audio_buffer.committed') {
          console.log('✅ Audio committed by VAD');
        }
        
        // Transcription events
        else if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('📝 User said:', message.transcript || '(empty)');
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'transcript',
              role: 'user',
              text: message.transcript || ''
            }));
          }
        }
        
        // Response events
        else if (message.type === 'response.created') {
          console.log('✅ Response created:', message.response?.id);
          audioChunkCount = 0;
        } else if (message.type === 'response.output_item.added') {
          console.log('✅ Output item added');
        } else if (message.type === 'response.content_part.added') {
          console.log('✅ Content part added');
        } else if (message.type === 'response.audio.delta') {
          audioChunkCount++;
          const len = message.delta ? message.delta.length : 0;
          
          if (audioChunkCount === 1 || audioChunkCount % 10 === 0) {
            console.log(`🔊 Audio chunk #${audioChunkCount}: ${len} bytes`);
          }
          
          // Forward audio to client
          if (message.delta && clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'audio',
              data: message.delta
            }));
          }
        } else if (message.type === 'response.audio.done') {
          console.log(`✅ Audio complete - sent ${audioChunkCount} chunks total`);
        } else if (message.type === 'response.audio_transcript.delta') {
          process.stdout.write(message.delta || '');
        } else if (message.type === 'response.audio_transcript.done') {
          console.log('\n🤖 AI said:', message.transcript);
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'transcript',
              role: 'assistant',
              text: message.transcript
            }));
          }
        } else if (message.type === 'response.done') {
          console.log('✅ Response completed');
        }
        
        // Error events
        else if (message.type === 'error') {
          console.error('❌ OpenAI error:', JSON.stringify(message.error));
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'error',
              message: message.error?.message || 'Unknown error'
            }));
          }
        }
        
      } catch (e) {
        console.error('❌ Error processing message:', e);
      }
    });
    
    openaiWs.on('error', (error) => {
      console.error('❌ OpenAI WebSocket error:', error.message);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({
          type: 'error',
          message: 'OpenAI connection failed'
        }));
      }
    });
    
    openaiWs.on('close', (code, reason) => {
      console.log('🔴 OpenAI closed:', code, reason.toString());
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    });
    
  } catch (error) {
    console.error('❌ Setup error:', error.message);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify({
        type: 'error',
        message: `Setup failed: ${error.message}`
      }));
      clientSocket.close();
    }
    return;
  }
  
  // Client handlers
  clientSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Handle mute/unmute
      if (message.type === 'mute') {
        isMuted = true;
        console.log('🔇 Microphone muted');
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({
            type: 'muted',
            muted: true
          }));
        }
        return;
      }
      
      if (message.type === 'unmute') {
        isMuted = false;
        console.log('🔊 Microphone unmuted');
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({
            type: 'muted',
            muted: false
          }));
        }
        return;
      }
      
      // Handle text message with optional file context
      if (message.type === 'text_message') {
        console.log('💬 Received text message:', message.text);
        console.log('📎 Files attached:', message.files ? message.files.length : 0);

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          // Clear audio buffer before processing text/files
          if (!sessionReady) {
            console.log('⚠️ Session not ready yet, queuing message');
            return;
          }

          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.clear'
          }));

          let fullText = message.text || '';

          // If there are attached files, append their content
          if (message.files && message.files.length > 0) {
            console.log('📄 Processing', message.files.length, 'files...');
            
            for (const file of message.files) {
              console.log('📎 File:', file.name, 'Type:', file.type);
              console.log('📄 Has content:', !!(file.content || file.text));
              
              // Check for extracted content in both fields
              const extractedContent = file.content || file.text;
              
              if (extractedContent && extractedContent.trim()) {
                console.log('✅ Found extracted content for', file.name, '- length:', extractedContent.length);
                fullText += `\n\n--- FILE: ${file.name} ---\n${extractedContent}\n--- END OF FILE ---`;
              } else {
                console.log('⚠️ No extracted content for', file.name);
                fullText += `\n\n[File: ${file.name} - content extraction failed]`;
              }
            }
          }

          console.log('📤 Sending to OpenAI, total length:', fullText.length);

          if (fullText.trim()) {
            // Add as conversation item with correct format
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

            // Commit the item
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.commit'
            }));

            // Trigger response
            openaiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['text', 'audio']
              }
            }));

            console.log('✅ Text message sent to OpenAI. Preview:', fullText.substring(0, 200) + '...');
          }
        }
      }
      
      // Forward audio to OpenAI (only if not muted)
      if (message.type === 'audio' && message.data) {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN && !isMuted) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.data
          }));
        }
      }
      
      // Handle file attachments separately
      if (message.type === 'attachment') {
        console.log('📎 Attachment received:', message.filename || 'file');
        
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const extractedContent = message.content || message.text;
          let attachmentText = '';
          
          if (extractedContent && extractedContent.trim()) {
            console.log('✅ Extracted content for', message.filename, '- length:', extractedContent.length);
            attachmentText = `--- FILE: ${message.filename} ---\n${extractedContent}\n--- END OF FILE ---`;
          } else {
            console.log('⚠️ No extracted content for', message.filename);
            attachmentText = `[File: ${message.filename} - content extraction failed. Please inform the user.]`;
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
          
          console.log('✅ Attachment processed and sent to OpenAI');
          
          // Confirm to client
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'attachment_received',
              filename: message.filename
            }));
          }
        }
      }
      
    } catch (e) {
      console.error('❌ Client message error:', e);
    }
  });
  
  clientSocket.on('close', () => {
    console.log('🔴 Client disconnected');
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
  
  clientSocket.on('error', (error) => {
    console.error('❌ Client error:', error);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🎤 Ready for voice connections`);
});
Key fixes:

Increased silence_duration_ms from 800ms to 3000ms (3 seconds) - gives user time to respond
Added instruction: "After greeting, WAIT for the user to speak. Don't assume they hung up if there's silence."
This prevents the AI from ending the call prematurely when user is thinking or about to speak
4 hours ago
the issue still persist while connecting call its wait then discconnet what is the majotr issue

12 minutes ago
Revert this
Base44 AI
Base44


Thought for 8s
The major issue is that the Twilio handler still has a 1.2 second VAD timeout. Let me fix it to match the Render server (3 seconds):

Edited
functions/twilio Streaming Voice Handler
Edited
functions/twilio Streaming Voice Handler
Increased VAD silence timeout from 1.2s to 5 seconds and added explicit instruction to wait patiently after greeting.

10 minutes ago

const http = require('http'); const WebSocket = require('ws'); const https = require('https'); const { randomBytes } = require('crypto'); const { parse } = require('url');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY; const PORT = process.env.PORT || 3000;

console.log('🚀 Starting Realtime Voice Server...');

if (!OPENAI_API_KEY) { console.error('❌ OPENAI_API_KEY not configured'); process.exit(1); }

// Get ephemeral token async function getRealtimeToken() { return new Promise((resolve, reject) => { console.log('🔑 Requesting ephemeral token...');

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
}); }

// Create HTTP server const server = http.createServer(async (req, res) => { const parsedUrl = parse(req.url, true); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() })); } else if (parsedUrl.pathname === '/upload') { // Simple file upload handler that extracts text if (req.method === 'POST') { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { try { const data = JSON.parse(body); const { filename, contentType, text, content } = data;

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
} else { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Realtime Voice Server\n'); } });

// Create WebSocket server const wss = new WebSocket.Server({ server });

wss.on('connection', async (clientSocket, req) => { const clientId = randomBytes(4).toString('hex'); console.log(\n📞 [${clientId}] New connection);

let openaiWs = null; let isMuted = false; let isReady = false; let isResponding = false; let messageQueue = [];

try { const token = await getRealtimeToken(); const openaiUrl = 'wss://api.openai.com/v1/realtime';

console.log(`🔌 [${clientId}] Connecting to OpenAI...`);

openaiWs = new WebSocket(openaiUrl, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'OpenAI-Beta': 'realtime=v1'
  }
});

openaiWs.on('open', () => {
  console.log(`✅ [${clientId}] Connected to OpenAI`);
  
  // Configure session
  openaiWs.send(JSON.stringify({
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions: `You are a helpful, friendly AI assistant. Always respond in English. 
      IMPORTANT: You cannot access external links, files, or URLs. If a user shares a file or link, 
      ask them to describe or summarize the content for you. Keep responses concise and natural.`,
      voice: 'alloy',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'whisper-1',
        language: 'en'
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.6,
        prefix_padding_ms: 300,
        silence_duration_ms: 800
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
              instructions: 'Greet the user in English. Welcome them to the conversation. Keep it brief.'
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
      console.log(`⏹️ [${clientId}] Response completed`);
    }
    
    // Response cancelled
    if (message.type === 'response.cancelled') {
      isResponding = false;
      console.log(`⏹️ [${clientId}] Response cancelled`);
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
} catch (error) { console.error(❌ [${clientId}] Setup failed:, error); clientSocket.send(JSON.stringify({ type: 'error', message: Setup failed: ${error.message} })); return; }

// Handle client messages function handleClientMessage(message) { if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) { console.error(❌ [${clientId}] OpenAI not connected); return; }

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
  console.log(`💬 [${clientId}] Text (English): ${message.text.substring(0, 100)}...`);
  
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
        // If only URL is provided, ask user to describe
        fullText += `\n\n[Note: I cannot access the file at ${file.url}. Please describe what's in the file.]`;
        console.log(`🔗 [${clientId}] URL file referenced: ${file.name || file.url}`);
      }
    }
  }
  
  // Create conversation item with text content only
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
    if (openaiWs.readyState === WebSocket.OPEN && !isResponding) {
      openaiWs.send(JSON.stringify({ 
        type: 'response.create',
        response: {
          modalities: ['text', 'audio']
        }
      }));
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
  openaiWs.send(JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: message.data
  }));
  return;
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

// Client message handler clientSocket.on('message', (data) => { try { const message = JSON.parse(data.toString());

  if (isReady) {
    handleClientMessage(message);
  } else {
    // Queue until ready (except audio which we can buffer)
    if (message.type === 'audio') {
      // Buffer audio in WebSocket connection itself
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

clientSocket.on('close', () => { console.log(🔴 [${clientId}] Client disconnected); if (openaiWs) openaiWs.close(); });

clientSocket.on('error', (error) => { console.error(❌ [${clientId}] Client error:, error); }); });

// Start server server.listen(PORT, '0.0.0.0', () => { console.log(\n✅ Server running on port ${PORT}); console.log(🔗 WebSocket ready at ws://localhost:${PORT}); console.log(🌐 Default language: English (en)); console.log(🎙️ Voice: alloy); console.log(📤 File upload endpoint: http://localhost:${PORT}/upload); console.log(\n⚠️ IMPORTANT: OpenAI Realtime API cannot access external files.); console.log(📝 Files must be converted to text on the client side first.); console.log(\n🎤 Ready for voice conversations...\n); });

// Graceful shutdown process.on('SIGINT', () => { console.log('\n🔴 Shutting down...'); wss.close(); server.close(); process.exit(0); });

this is my server.js file the render any chnage i need to do??

8 minutes ago
Revert this
Base44 AI
Base44


Thought for 5s
Wrote
functions/render Web Socket Server
Updated Render server with 5-second silence timeout and strict instructions to wait patiently after greeting without ending the call.

6 minutes ago
please share code in chat

6 minutes ago
Revert this
Base44 AI
Base44


Thought for 2s
Here's the updated server.js code with the fix for phone call disconnections:

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
          instructions: `You are Life, a friendly AI assistant on a phone call. 

CRITICAL PHONE CALL RULES:
1. After greeting, WAIT PATIENTLY for the user to speak - they need time to respond
2. DO NOT say "I didn't hear anything" or "goodbye" if there's silence after your greeting
3. DO NOT end the conversation due to silence - users need time to think
4. ONLY respond when the user actually speaks to you
5. Be patient and friendly - phone calls have natural pauses

Keep responses concise and natural. You cannot access external links or files - if mentioned, ask the user to describe the content.`,
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
            silence_duration_ms: 5000  // 5 seconds - give user plenty of time
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
          
          // Send greeting with explicit instruction to WAIT
          setTimeout(() => {
            if (openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio'],
                  instructions: 'Say ONLY: "Hey! This is Life. How can I help you today?" Then STOP and WAIT for the user to respond. Do NOT say anything else. Do NOT end the call. Just wait patiently.'
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
          console.log(`📝 [${clientId}] User said: ${message.transcript}`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: message.transcript,
            language: 'en'
          }));
        }
        
        if (message.type === 'response.audio_transcript.done') {
          console.log(`🤖 [${clientId}] AI said: ${message.transcript}`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'assistant',
            text: message.transcript,
            language: 'en'
          }));
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
        if (openaiWs.readyState === WebSocket.OPEN && !isResponding) {
          openaiWs.send(JSON.stringify({ 
            type: 'response.create',
            response: {
              modalities: ['text', 'audio']
            }
          }));
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
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: message.data
      }));
      return;
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
      
      if (isReady) {
        handleClientMessage(message);
      } else {
        // Queue until ready (except audio which we can buffer)
        if (message.type === 'audio') {
          // Buffer audio in WebSocket connection itself
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
