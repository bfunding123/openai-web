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
