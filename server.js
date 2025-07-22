// server.js - Signaling Server with Bun
const tours = new Map(); // tourId -> { guide: ws, participants: Set<ws> }
const connections = new Map(); // ws -> { userId, tourId, role }

const server = Bun.serve({
  port: process.env.PORT || 3000,
  websocket: {
    message(ws, message) {
      try {
        const data = JSON.parse(message);
        handleMessage(ws, data);
      } catch (error) {
        console.error('Error parsing message:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    },

    open(ws) {
      console.log('Client connected');
      ws.send(JSON.stringify({ type: 'connected' }));
    },

    close(ws) {
      handleDisconnection(ws);
    }
  },

  fetch(req, server) {
    const url = new URL(req.url);

    // --- CORS Headers ---
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // --- Preflight Request (OPTIONS) ---
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204, // No Content
        headers: corsHeaders
      });
    }
    
    // --- WebSocket Upgrade ---
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) {
        return; 
      }
      return new Response("WebSocket upgrade failed", { 
        status: 500, 
        headers: corsHeaders
      });
    }

    // --- Health Check Endpoint ---
    if (url.pathname === "/health") {
      const body = JSON.stringify({ 
        status: 'ok', 
        tours: tours.size,
        connections: connections.size 
      });
      return new Response(body, {
        headers: { 
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    // --- Default Response for other paths ---
    return new Response("WebRTC Signaling Server", { 
      status: 200,
      headers: corsHeaders
    });
  },
});

function handleMessage(ws, data) {
  const { type, tourId, userId, role } = data;
  const connection = connections.get(ws);

  switch (type) {
    case 'join-tour':
      joinTour(ws, tourId, userId, role);
      break;

    case 'leave-tour':
      leaveTour(ws);
      break;

    case 'offer': // From guide to all participants
      if (connection) relayToParticipants(connection.tourId, data, ws);
      break;

    case 'answer': // From participant to guide
      if (connection) relayToGuide(connection.tourId, data);
      break;

    case 'ice-candidate': // From either guide or participant
      if (connection) relayIceCandidate(connection, data);
      break;
      
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

function joinTour(ws, tourId, userId, role) {
  leaveTour(ws); // Ensure user is not in other tours

  if (!tours.has(tourId)) {
    tours.set(tourId, { guide: null, participants: new Set() });
  }

  const tour = tours.get(tourId);
  connections.set(ws, { userId, tourId, role });

  if (role === 'guide') {
    if (tour.guide) {
      ws.send(JSON.stringify({ type: 'error', message: 'Tour already has a guide' }));
      connections.delete(ws);
      return;
    }
    tour.guide = ws;
    console.log(`Guide ${userId} created/joined tour ${tourId}`);
  } else if (role === 'participant') {
    tour.participants.add(ws);
    console.log(`Participant ${userId} joined tour ${tourId} (${tour.participants.size} total)`);
    
    // Notify the guide that a new participant joined
    if (tour.guide) {
      tour.guide.send(JSON.stringify({
        type: 'participant-joined',
        participantId: userId,
        totalParticipants: tour.participants.size
      }));
    }
  }

  ws.send(JSON.stringify({
    type: 'joined-tour',
    tourId,
    role,
    participantCount: tour.participants.size,
    hasGuide: !!tour.guide
  }));
}

function leaveTour(ws) {
  const connection = connections.get(ws);
  if (!connection) return;

  const { userId, tourId, role } = connection;
  const tour = tours.get(tourId);
  
  if (!tour) return;

  if (role === 'guide' && tour.guide === ws) {
    tour.guide = null;
    console.log(`Guide ${userId} left tour ${tourId}`);
    
    // Notify all participants that the guide left
    tour.participants.forEach(participant => {
      participant.send(JSON.stringify({ type: 'guide-left', tourId }));
    });
  } else if (role === 'participant') {
    tour.participants.delete(ws);
    console.log(`Participant ${userId} left tour ${tourId} (${tour.participants.size} remaining)`);
    
    // Notify the guide that a participant left
    if (tour.guide) {
      tour.guide.send(JSON.stringify({
        type: 'participant-left',
        participantId: userId,
        totalParticipants: tour.participants.size
      }));
    }
  }

  // If tour is empty, delete it
  if (!tour.guide && tour.participants.size === 0) {
    tours.delete(tourId);
    console.log(`Tour ${tourId} deleted (empty)`);
  }

  connections.delete(ws);
}

function relayToParticipants(tourId, data, senderWs) {
  const tour = tours.get(tourId);
  if (!tour) return;
  
  const senderConnection = connections.get(senderWs);
  if (!senderConnection || senderConnection.role !== 'guide') return;

  const message = JSON.stringify({ ...data, fromRole: 'guide' });
  tour.participants.forEach(p => {
    // Avoid sending the offer back to the sender if they re-join as a participant somehow
    if (p !== senderWs) {
       p.send(message);
    }
  });
}

function relayToGuide(tourId, data) {
  const tour = tours.get(tourId);
  if (!tour || !tour.guide) return;
  
  const message = JSON.stringify({ ...data, fromRole: 'participant' });
  tour.guide.send(message);
}

function relayIceCandidate(senderConnection, data) {
  const { tourId, role } = senderConnection;
  const tour = tours.get(tourId);
  if (!tour) return;
  
  const message = JSON.stringify({ ...data, fromRole: role });

  if (role === 'guide') {
    // Guide sends candidate to all participants
    tour.participants.forEach(p => p.send(message));
  } else {
    // Participant sends candidate to the guide
    if (tour.guide) {
      tour.guide.send(message);
    }
  }
}

function handleDisconnection(ws) {
  console.log('Client disconnected');
  leaveTour(ws);
}

// Keep-alive ping
setInterval(() => {
    for (const ws of connections.keys()) {
        if (ws.readyState === ws.OPEN) {
            ws.ping();
        }
    }
}, 30000);

console.log(`🚀 Signaling server running on port ${server.port}`);
console.log(`WebSocket endpoint: ws://localhost:${server.port}/ws`);
console.log(`Health check: http://localhost:${server.port}/health`);
