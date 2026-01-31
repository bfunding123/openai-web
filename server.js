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

// Function to perform web search using your LLM
async function performWebSearch(query) {
  try {
    console.log(`🔍 Performing web search for: "${query}"`);
    
    const searchPrompt = `Find current, accurate, real-time information about: ${query}. 
    Provide a concise, factual answer. If this is about weather, include temperature, conditions, and forecast.
    If about news, include recent developments. If about sports, include scores or standings.
    Be specific with numbers, dates, and sources when possible.`;
    
    const response = await fetch('https://life-ai-360-bz26.onrender.com/api/integrations/Core.InvokeLLM', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        prompt: searchPrompt,
        add_context_from_internet: true,
        max_tokens: 500
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log(`✅ Search completed, result type:`, typeof result);
    
    // Handle different response formats
    let searchResult;
    if (typeof result === 'string') {
      searchResult = result;
    } else if (result.response || result.answer || result.content) {
      searchResult = result.response || result.answer || result.content || JSON.stringify(result);
    } else {
      searchResult = JSON.stringify(result);
    }
    
    return {
      success: true,
      query: query,
      result: searchResult.substring(0, 2000), // Limit length
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('❌ Search error:', error);
    return {
      success: false,
      query: query,
      error: error.message,
      fallback: `I searched for "${query}" but couldn't retrieve real-time information at the moment. For current weather, you might check weather.com or a weather app. For news, check news websites or apps.`
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
  } else if (parsedUrl.pathname === '/search') {
    // Web search endpoint
    const query = parsedUrl.query.q;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query parameter (q) required' }));
      return;
    }
    
    try {
      const result = await performWebSearch(query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Search failed', details: error.message }));
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
      
      // Configure session with CORRECT tool configuration
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `You are Life, a friendly AI voice assistant. You can search the web for real-time information using the web_search tool.
          
          IMPORTANT: When users ask about:
          - Weather (current weather, temperature, forecast)
          - News (current events, breaking news)
          - Sports (scores, schedules, results)
          - Stocks (prices, market updates)
          - Time-sensitive information
          
          You MUST use the web_search tool to get current information.
          
          For weather: Ask for location if not provided, then search for "current weather in [location]"
          For news: Search for "latest news about [topic]"
          For sports: Search for "latest scores [team/sport]"
          
          Keep responses concise, friendly, and conversational.`,
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
          temperature: 0.7,
          tools: [
            {
              type: 'function',
              name: 'web_search',
              description: 'Search the web for current, real-time information. Use this for weather, news, sports, stocks, and any time-sensitive queries.',
              parameters: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'The search query to find current information (e.g., "current weather in London", "latest news about technology", "NBA scores today")'
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
        message: 'Connected to OpenAI with web search capabilities',
        language: 'en',
        voice: 'alloy',
        capabilities: {
          files: 'text_only',
          web_search: true,
          note: 'Can search for real-time weather, news, sports, and more'
        }
      }));
    });
    
    openaiWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // LOG IMPORTANT MESSAGES FOR DEBUGGING
        if (!['response.audio.delta'].includes(message.type)) {
          console.log(`🔵 [${clientId}] OpenAI: ${message.type}`);
          if (['error', 'response.function_call_arguments.done', 'response.created', 'response.done'].includes(message.type)) {
            console.log(`📋 [${clientId}] Message details:`, JSON.stringify(message, null, 2));
          }
        }
        
        // Session ready - process queue
        if (message.type === 'session.updated') {
          console.log(`✅ [${clientId}] Session ready with web search capabilities`);
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
          console.log(`⏹️ [${clientId}] Response completed - ready for next input`);
        }
        
        // Transcriptions
        if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`📝 [${clientId}] User: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: message.transcript,
            language: 'en'
          }));
        }
        
        if (message.type === 'response.audio_transcript.done') {
          console.log(`🤖 [${clientId}] AI: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'assistant',
            text: message.transcript,
            language: 'en'
          }));
        }
        
        // Function calls - web search
        if (message.type === 'response.function_call_arguments.done') {
          console.log(`🔧 [${clientId}] Function call: ${message.name}`);
          
          if (message.name === 'web_search') {
            try {
              const args = JSON.parse(message.arguments);
              console.log(`🔍 [${clientId}] Web search query: "${args.query}"`);
              
              // Perform web search
              performWebSearch(args.query).then(searchResult => {
                console.log(`✅ [${clientId}] Search completed, sending result back`);
                
                // Send function result back to OpenAI
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: message.call_id,
                    output: searchResult.success ? 
                      `Search results for "${args.query}":\n${searchResult.result}` : 
                      searchResult.fallback
                  }
                }));
                
                // Wait a moment then trigger response with the search result
                setTimeout(() => {
                  if (openaiWs.readyState === WebSocket.OPEN) {
                    console.log(`🚀 [${clientId}] Triggering response with search results`);
                    openaiWs.send(JSON.stringify({
                      type: 'response.create'
                    }));
                  }
                }, 100);
                
              }).catch(error => {
                console.error(`❌ [${clientId}] Search failed:`, error);
                
                // Send error back
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: message.call_id,
                    output: `I couldn't search for "${args.query}" right now. Please try again or check online directly.`
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
        
        // Function call output created
        if (message.type === 'conversation.item.created' && message.item?.type === 'function_call_output') {
          console.log(`📤 [${clientId}] Function output created`);
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
    
    // Text messages
    if (message.type === 'text_message' && message.text) {
      console.log(`💬 [${clientId}] Text: "${message.text.substring(0, 100)}..."`);
      
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
      
      // Append file text content if provided
      let fullText = message.text;
      if (message.files && message.files.length > 0) {
        console.log(`📎 [${clientId}] Processing ${message.files.length} file(s) as text`);
        for (const file of message.files) {
          if (file.text || file.content) {
            const fileText = file.text || file.content || '';
            const fileName = file.name || 'File';
            fullText += `\n\n[Content from ${fileName}]:\n${fileText}`;
          }
        }
      }
      
      // Create conversation item
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: fullText }]
        }
      }));
      
      // Trigger response
      setTimeout(() => {
        if (openaiWs.readyState === WebSocket.OPEN && !isResponding) {
          console.log(`🚀 [${clientId}] Creating response...`);
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
        language: 'en'
      }));
      
      return;
    }
    
    // Audio streaming
    if (message.type === 'audio' && message.data && !isMuted) {
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: message.data
      }));
      return;
    }
    
    // Other message types...
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
      console.log(`🌐 [${clientId}] Language change: ${message.language}`);
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
  
  // Client message handler
  clientSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
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
  console.log(`🔍 Web search: ENABLED via LLM with internet context`);
  console.log(`📤 File upload endpoint: http://localhost:${PORT}/upload`);
  console.log(`🔎 Search endpoint: http://localhost:${PORT}/search?q=your+query`);
  console.log(`\n🎤 Ready for voice conversations with real-time web search...\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
