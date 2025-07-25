// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

// Database
const { Client } = require('pg');

// Database connection
const dbClient = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Connect to database
dbClient.connect()
  .then(() => console.log('Connected to PostgreSQL database'))
  .catch(err => console.error('Database connection error:', err));

// Database helper functions
async function createCall(callSid, fromNumber) {
  try {
    const result = await dbClient.query(
      'INSERT INTO calls (call_sid, from_number, started_at) VALUES ($1, $2, $3) RETURNING id',
      [callSid, fromNumber, new Date()]
    );
    console.log('Database: Call created with ID:', result.rows[0].id);
    return result.rows[0].id;
  } catch (error) {
    console.error('Database: Error creating call:', error);
    return null;
  }
}

async function updateCallTranscript(callId, transcript) {
  try {
    await dbClient.query(
      'UPDATE calls SET transcript = $1 WHERE id = $2',
      [transcript, callId]
    );
    console.log('Database: Transcript updated for call:', callId);
  } catch (error) {
    console.error('Database: Error updating transcript:', error);
  }
}

async function endCall(callId, finalTranscript) {
  try {
    await dbClient.query(
      'UPDATE calls SET ended_at = $1, transcript = $2 WHERE id = $3',
      [new Date(), finalTranscript, callId]
    );
    console.log('Database: Call ended:', callId);
  } catch (error) {
    console.error('Database: Error ending call:', error);
  }
}

async function checkAlertKeywords(callId, transcript, fromNumber) {
  try {
    // Check for alert keywords in the transcript
    // For now, check for emergency keywords
    const emergencyKeywords = ['help', 'emergency', 'pain', 'fell', 'hurt', 'sick', 'hospital'];
    const lowerTranscript = transcript.toLowerCase();
    
    const hasAlert = emergencyKeywords.some(keyword => lowerTranscript.includes(keyword));
    
    if (hasAlert) {
      await dbClient.query(
        'UPDATE calls SET alert_triggered = TRUE WHERE id = $1',
        [callId]
      );
      console.log('Database: ALERT TRIGGERED for call:', callId, 'Keywords detected in:', transcript);
      
      // TODO: Send SMS/email alerts to family members
      // This would integrate with alert_criteria table and notification system
      
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Database: Error checking alert keywords:', error);
    return false;
  }
}

// Twilio
const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest); // Create HTTP server to handle requests

const HTTP_SERVER_PORT = 8080; // Define the server port
let streamSid = ''; // Variable to store stream session ID

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

// Deepgram Speech to Text
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();

// Deepgram Text to Speech Websocket
const WebSocket = require('ws');
const deepgramTTSWebsocketURL = 'wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none';

// Performance Timings
let llmStart = 0;
let ttsStart = 0;
let firstByte = true;
let speaking = false;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"]

// Function to handle HTTP requests
function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

/*
 Easy Debug Endpoint
*/
dispatcher.onGet("/", function (req, res) {
  console.log('GET /');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, World!');
});

/*
 Twilio streams.xml
*/
dispatcher.onPost("/twiml", function (req, res) {
  let filePath = path.join(__dirname + "/templates", "streams.xml");
  let stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": stat.size,
  });

  let readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

/*
  Websocket Server
*/
mediaws.on("connect", function (connection) {
  console.log("twilio: Connection accepted");
  new MediaStream(connection);
});

/*
  Twilio Bi-directional Streaming
*/
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramWebsocket(this);
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;

    this.messages = [];
    this.repeatCount = 0;
    
    // Database tracking
    this.callId = null;
    this.fromNumber = null;
    this.callSid = null;
    this.transcript = '';
  }

  // Function to process incoming messages
  processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      if (data.event === "connected") {
        console.log("twilio: Connected event received: ", data);
      }
      if (data.event === "start") {
        console.log("twilio: Start event received: ", data);
        
        // Extract call information and create database record
        this.callSid = data.streamSid;
        this.fromNumber = data.start?.customParameters?.From || 'unknown';
        
        // Create call record in database
        createCall(this.callSid, this.fromNumber)
          .then(callId => {
            this.callId = callId;
            console.log('Database: Call tracking started for:', this.callSid);
          })
          .catch(err => console.error('Database: Failed to create call record:', err));
      }
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          console.log("twilio: Media event received: ", data);
          console.log("twilio: Suppressing additional messages...");
          this.hasSeenMedia = true;
        }
        if (!streamSid) {
          console.log('twilio: streamSid=', streamSid);
          streamSid = data.streamSid;
        }
        if (data.media.track == "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          this.deepgram.send(rawAudio);
        }
      }
      if (data.event === "mark") {
        console.log("twilio: Mark event received", data);
      }
      if (data.event === "close") {
        console.log("twilio: Close event received: ", data);
        this.close();
      }
    } else if (message.type === "binary") {
      console.log("twilio: binary message received (not supported)");
    }
  }

  // Function to handle connection close
  close() {
    console.log("twilio: Closed");
    
    // Save final transcript and end call record
    if (this.callId && this.transcript) {
      endCall(this.callId, this.transcript)
        .then(() => console.log('Database: Call ended and transcript saved'))
        .catch(err => console.error('Database: Error ending call:', err));
    }
  }
}

/*
  OpenAI Streaming LLM
*/
async function promptLLM(mediaStream, prompt) {
  const stream = openai.beta.chat.completions.stream({
    model: 'gpt-4o-mini',
    stream: true,
    messages: [
      {
        role: 'assistant',
        content: `You are “Elder Companion,” a warm, patient phone companion speaking with an older adult.

Objectives:
1. Greet them by first name if known.
2. Ask one simple open-ended question at a time about their day, meals, mood, or plans.
3. Reflect back something they just said (“That sounds relaxing,” etc.) before moving on.
4. Keep responses short: 1–2 sentences. Speak plainly. No emojis or markup.
5. If they seem confused or go silent, gently re-engage: “Are you still there?” then offer a simple prompt.
6. NEVER give medical, legal, or financial advice. If asked, say: “I can’t advise on that, but you might tell a family member.”
7. If they say anything that sounds urgent or includes words like “help”, “emergency”, “pain”, or “fell”, reply calmly: 
   “I’m here with you. I will let your family know.” Then end with a comforting phrase and stop generating.
8. Do not mention you are an AI unless they ask directly. If asked, answer briefly: “I’m a virtual companion calling to check in.”

Style: Warm, respectful, lightly upbeat. Avoid jokes that could confuse. One turn at a time.
`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
  });

  speaking = true;
  let firstToken = true;
  for await (const chunk of stream) {
    if (speaking) {
      if (firstToken) {
        const end = Date.now();
        const duration = end - llmStart;
        ttsStart = Date.now();
        console.warn('\n>>> openai LLM: Time to First Token = ', duration, '\n');
        firstToken = false;
        firstByte = true;
      }
      chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        process.stdout.write(chunk_message)
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)){
          send_first_sentence_input_time = Date.now();
        }
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Speak', 'text': chunk_message }));
      }
    }
  }
  // Tell TTS Websocket were finished generation of tokens
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
}

function containsAnyChars(str) {
  // Convert the string to an array of characters
  let strArray = Array.from(str);
  
  // Check if any character in strArray exists in chars_to_check
  return strArray.some(char => chars_to_check.includes(char));
}

/*
  Deepgram Streaming Text to Speech
*/
const setupDeepgramWebsocket = (mediaStream) => {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  };
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on('open', function open() {
    console.log('deepgram TTS: Connected');
  });

  ws.on('message', function incoming(data) {
    // Handles barge in
    if (speaking) {
      try {
        let json = JSON.parse(data.toString());
        console.log('deepgram TTS: ', data.toString());
        return;
      } catch (e) {
        // Ignore
      }
      if (firstByte) {
        const end = Date.now();
        const duration = end - ttsStart;
        console.warn('\n\n>>> deepgram TTS: Time to First Byte = ', duration, '\n');
        firstByte = false;
        if (send_first_sentence_input_time){
          console.log(`>>> deepgram TTS: Time to First Byte from end of sentence token = `, (end - send_first_sentence_input_time));
        }
      }
      const payload = data.toString('base64');
      const message = {
        event: 'media',
        streamSid: streamSid,
        media: {
          payload,
        },
      };
      const messageJSON = JSON.stringify(message);

      // console.log('\ndeepgram TTS: Sending data.length:', data.length);
      mediaStream.connection.sendUTF(messageJSON);
    }
  });

  ws.on('close', function close() {
    console.log('deepgram TTS: Disconnected from the WebSocket server');
  });

  ws.on('error', function error(error) {
    console.log("deepgram TTS: error received");
    console.error(error);
  });
  return ws;
}

/*
  Deepgram Streaming Speech to Text
*/
const setupDeepgram = (mediaStream) => {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
    // Model
    model: "nova-2-phonecall",
    language: "en",
    // Formatting
    smart_format: true,
    // Audio
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    multichannel: false,
    // End of Speech
    no_delay: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive(); // Keeps the connection alive
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram STT: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log(`deepgram STT: [Speech Final] ${utterance}`);
            
            // Update transcript in MediaStream and database
            mediaStream.transcript += (mediaStream.transcript ? ' ' : '') + utterance;
            if (mediaStream.callId) {
              updateCallTranscript(mediaStream.callId, mediaStream.transcript);
              
              // Check for alert keywords
              checkAlertKeywords(mediaStream.callId, utterance, mediaStream.fromNumber);
            }
            
            llmStart = Date.now();
            promptLLM(mediaStream, utterance); // Send the final transcript to OpenAI for response
          } else {
            console.log(`deepgram STT:  [Is Final] ${transcript}`);
          }
        } else {
          console.log(`deepgram STT:    [Interim Result] ${transcript}`);
          if (speaking) {
            console.log('twilio: clear audio playback', streamSid);
            // Handles Barge In
            const messageJSON = JSON.stringify({
              "event": "clear",
              "streamSid": streamSid,
            });
            mediaStream.connection.sendUTF(messageJSON);
            mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Clear' }));
            speaking = false;
          }
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log(`deepgram STT: [Speech Final] ${utterance}`);
        
        // Update transcript in MediaStream and database
        mediaStream.transcript += (mediaStream.transcript ? ' ' : '') + utterance;
        if (mediaStream.callId) {
          updateCallTranscript(mediaStream.callId, mediaStream.transcript);
          
          // Check for alert keywords
          checkAlertKeywords(mediaStream.callId, utterance, mediaStream.fromNumber);
        }
        
        llmStart = Date.now();
        promptLLM(mediaStream, utterance);
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram STT: disconnected");
      clearInterval(keepAlive);
      deepgram.requestClose();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram STT: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram STT: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram STT: metadata received:", data);
    });
  });

  return deepgram;
};

wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
