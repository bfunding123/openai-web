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

// Function to perform web search - SIMPLIFIED VERSION
async function performWebSearch(query) {
  try {
    console.log(`🔍 Performing web search for: "${query}"`);
    
    // Try multiple endpoints or fallbacks
    const endpoints = [
      'https://life-ai-360-bz26.onrender.com/api/integrations/Core.InvokeLLM',
      'https://life-ai-360-bz26.onrender.com/api/chat/completions',
      'https://life-ai-360-bz26.onrender.com/api/v1/chat'
    ];
    
    let lastError = null;
    
    for (const endpoint of endpoints) {
      try {
        console.log(`🔗 Trying endpoint: ${endpoint}`);
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            prompt: `Find current, accurate information about: ${query}. Provide a concise answer with specific details.`,
            add_context_from_internet: true,
            max_tokens: 300
          }),
          timeout: 5000
        });
        
        console.log(`📊 Response status: ${response.status}`);
        
        if (response.ok) {
          const result = await response.json();
          console.log(`✅ Search completed via ${endpoint}`);
          
          // Extract text from response
          let searchResult;
          if (typeof result === 'string') {
            searchResult = result;
          } else if (result.response || result.answer || result.content || result.message) {
            searchResult = result.response || result.answer || result.content || result.message;
          } else if (result.choices && result.choices[0] && result.choices[0].message) {
            searchResult = result.choices[0].message.content;
          } else {
            searchResult = JSON.stringify(result);
          }
          
          return {
            success: true,
            query: query,
            result: searchResult.substring(0, 1500),
            timestamp: new Date().toISOString()
          };
        } else {
          console.log(`❌ Endpoint ${endpoint} returned ${response.status}`);
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (endpointError) {
        console.log(`❌ Endpoint ${endpoint} failed:`, endpointError.message);
        lastError = endpointError;
      }
    }
    
    // If all endpoints fail, provide a fallback response
    console.log(`❌ All search endpoints failed, using fallback`);
    
    // Generate intelligent fallback based on query
    let fallback = `I searched for "${query}" but couldn't retrieve real-time information. `;
    
    if (query.toLowerCase().includes('weather')) {
      fallback += `For current weather, you can check weather.com, accuweather.com, or your local weather service.`;
    } else if (query.toLowerCase().includes('news')) {
      fallback += `For the latest news, check reputable news websites like BBC, CNN, or Reuters.`;
    } else if (query.toLowerCase().includes('score') || query.toLowerCase().includes('sport')) {
      fallback += `For sports scores, check ESPN, BBC Sport, or your favorite sports app.`;
    } else {
      fallback += `You might want to search online directly for the most current information.`;
    }
    
    return {
      success: false,
      query: query,
      error: lastError?.message || 'All endpoints failed',
      fallback: fallback
    };
    
  } catch (error) {
    console.error('❌ Search function error:', error);
    return {
      success: false,
      query: query,
      error: error.message,
      fallback: `Unable to search for "${query}" at the moment. Please try a web search directly.`
    };
  }
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
  } else if (parsedUrl.pathname === '/test-search') {
    // Test search endpoint
    const query = parsedUrl.query.q || 'current weather';
    try {
      const result = await performWebSearch(query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Test failed', details: error.message }));
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
  console.log(`\n📞 [${clientId}] New connection from ${req.socket.remoteAddress}`);
  
  let openaiWs = null;
  let isMuted = false;
  let isReady = false;
  let isResponding = false;
  let messageQueue = [];
  let currentLanguage = 'en';
  
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
      
      // Configure session
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `You are Life, a friendly AI voice assistant. 
          
          IMPORTANT RULES:
          1. Always speak in English by default.
          2. For current information (weather, news, sports, stocks), use the web_search tool.
          3. If web_search fails, be honest and suggest checking online directly.
          4. Keep responses concise (1-2 sentences for answers).
          5. Be helpful and friendly.
          
          WEB SEARCH GUIDELINES:
          - Weather: Ask for location if missing, then search "current weather in [location]"
          - News: Search "latest news about [topic]"
          - Sports: Search "latest scores [team/sport]"
          - Stocks: Search "current stock price of [company]"
          
          Example user question: "What's the weather?" 
          Your action: Use web_search with query "current weather"`,
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
            silence_duration_ms: 1000
          },
          temperature: 0.7,
          tools: [
            {
              type: 'function',
              name: 'web_search',
              description: 'Search for current, real-time information. Use for weather, news, sports, stocks, etc.',
              parameters: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Search query (e.g., "current weather in London", "latest news", "NBA scores")'
                  }
                },
                required: ['query']
              }
            }
          ]
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
        
        // DEBUG: Log all non-audio messages
        if (!['response.audio.delta', 'response.audio_transcript.delta'].includes(message.type)) {
          console.log(`🔵 [${clientId}] OpenAI: ${message.type}`);
        }
        
        // Critical debug messages
        if (['error', 'response.function_call_arguments.done', 'conversation.item.input_audio_transcription.completed'].includes(message.type)) {
          console.log(`📋 [${clientId}] ${message.type}:`, JSON.stringify(message, null, 2));
        }
        
        // Session ready
        if (message.type === 'session.updated') {
          console.log(`✅ [${clientId}] Session ready`);
          isReady = true;
          
          // Process queued messages
          while (messageQueue.length > 0) {
            const queuedMsg = messageQueue.shift();
            handleClientMessage(queuedMsg);
          }
          
          // Send greeting
          setTimeout(() => {
            if (openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio'],
                  instructions: 'Greet the user in English. Say "Hello! I am Life, your AI assistant. I can help answer questions and search for current information. What would you like to know?"'
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
        
        // Transcriptions
        if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`📝 [${clientId}] User said: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: message.transcript,
            language: currentLanguage
          }));
        }
        
        if (message.type === 'response.audio_transcript.done') {
          console.log(`🤖 [${clientId}] AI said: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'assistant',
            text: message.transcript,
            language: currentLanguage
          }));
        }
        
        // Function calls
        if (message.type === 'response.function_call_arguments.done') {
          console.log(`🔧 [${clientId}] Function call: ${message.name}`);
          
          if (message.name === 'web_search') {
            try {
              const args = JSON.parse(message.arguments);
              console.log(`🔍 [${clientId}] Web search query: "${args.query}"`);
              
              // Perform search
              performWebSearch(args.query).then(searchResult => {
                console.log(`✅ [${clientId}] Search result: ${searchResult.success ? 'Success' : 'Failed'}`);
                
                const output = searchResult.success ? 
                  `Based on my search for "${args.query}": ${searchResult.result}` : 
                  searchResult.fallback;
                
                // Send result back
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: message.call_id,
                    output: output
                  }
                }));
                
                // Trigger response
                setTimeout(() => {
                  if (openaiWs.readyState === WebSocket.OPEN) {
                    openaiWs.send(JSON.stringify({
                      type: 'response.create'
                    }));
                  }
                }, 100);
                
              }).catch(error => {
                console.error(`❌ [${clientId}] Search promise error:`, error);
                
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: message.call_id,
                    output: `I encountered an error while searching for "${args.query}". Please try asking again or check online.`
                  }
                }));
                
                setTimeout(() => {
                  if (openaiWs.readyState === WebSocket.OPEN) {
                    openaiWs.send(JSON.stringify({
                      type: 'response.create'
                    }));
                  }
                }, 100);
              });
              
            } catch (error) {
              console.error(`❌ [${clientId}] Function call parse error:`, error);
            }
          }
        }
        
        // Errors
        if (message.type === 'error') {
          console.error(`❌ [${clientId}] OpenAI error:`, message.error);
          isResponding = false;
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
    
    console.log(`📤 [${clientId}] Handling: ${message.type}`);
    
    // Audio streaming
    if (message.type === 'audio' && message.data && !isMuted) {
      // DEBUG: Log first few bytes of audio
      if (message.data.length > 0) {
        console.log(`🎤 [${clientId}] Audio: ${message.data.substring(0, 20)}... (${message.data.length} bytes)`);
      }
      
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: message.data
      }));
      return;
    }
    
    // Text messages
    if (message.type === 'text_message' && message.text) {
      console.log(`💬 [${clientId}] Text: "${message.text}"`);
      
      if (isResponding) {
        console.log(`⏳ [${clientId}] Skipping - response in progress`);
        return;
      }
      
      // Clear audio buffer
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      
      // Create conversation item
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: message.text }]
        }
      }));
      
      // Trigger response
      setTimeout(() => {
        if (openaiWs.readyState === WebSocket.OPEN && !isResponding) {
          openaiWs.send(JSON.stringify({ 
            type: 'response.create'
          }));
        }
      }, 200);
      
      return;
    }
    
    // Other message types...
    if (message.type === 'mute') {
      isMuted = true;
      console.log(`🔇 [${clientId}] Muted`);
      return;
    }
    
    if (message.type === 'unmute') {
      isMuted = false;
      console.log(`🔊 [${clientId}] Unmuted`);
      return;
    }
    
    if (message.type === 'set_language' && message.language) {
      console.log(`🌐 [${clientId}] Language change: ${message.language}`);
      currentLanguage = message.language;
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_transcription: {
            model: 'whisper-1',
            language: message.language
          }
        }
      }));
      return;
    }
  }
  
  // Client message handler
  clientSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // DEBUG: Log all incoming messages
      console.log(`📥 [${clientId}] Received: ${message.type}, isReady: ${isReady}`);
      
      if (isReady) {
        handleClientMessage(message);
      } else {
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
  console.log(`🔍 Web search: ENABLED (with fallback)`);
  console.log(`🩺 Health check: http://localhost:${PORT}/health`);
  console.log(`🧪 Test search: http://localhost:${PORT}/test-search?q=weather`);
  console.log(`\n🎤 Ready for voice conversations...\n`);
});

process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
