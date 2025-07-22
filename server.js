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

    // Add CORS headers for all HTTP responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // Or specify your app's domain for better security
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight requests for CORS
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) {
        return; // Successfully upgraded to WebSocket
      }
      return new Response("Upgrade failed", { status: 500 });
    }

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        tours: tours.size,
        connections: connections.size 
      }), {
        headers: { 
          "Content-Type": "application/json",
          ...corsHeaders 
        }
      });
    }

    return new Response("WebRTC Signaling Server", { 
      status: 200,
      headers: corsHeaders 
    });
  },
});

function handleMessage(ws, data) {
  const { type, tourId, userId, role } = data;

  switch (type) {
    case 'join-tour':
      joinTour(ws, tourId, userId, role);
      break;

    case 'leave-tour':
      leaveTour(ws);
      break;

    case 'offer':
      relayToParticipants(ws, data);
      break;

    case 'answer':
      relayToGuide(ws, data);
      break;

    case 'ice-candidate':
      relayIceCandidate(ws, data);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

function joinTour(ws, tourId, userId, role) {
  // Limpiar conexión anterior si existe
  leaveTour(ws);

  // Crear tour si no existe
  if (!tours.has(tourId)) {
    tours.set(tourId, { guide: null, participants: new Set() });
  }

  const tour = tours.get(tourId);
  connections.set(ws, { userId, tourId, role });

  if (role === 'guide') {
    // Solo puede haber un guía
    if (tour.guide) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Tour already has a guide' 
      }));
      return;
    }
    
    tour.guide = ws;
    console.log(`Guide ${userId} joined tour ${tourId}`);
    
    // Notificar a participantes que el guía se conectó
    tour.participants.forEach(participant => {
      participant.send(JSON.stringify({
        type: 'guide-joined',
        tourId,
        guideId: userId
      }));
    });

  } else if (role === 'participant') {
    tour.participants.add(ws);
    console.log(`Participant ${userId} joined tour ${tourId} (${tour.participants.size} total)`);
    
    // Notificar al guía sobre nuevo participante
    if (tour.guide) {
      tour.guide.send(JSON.stringify({
        type: 'participant-joined',
        tourId,
        participantId: userId,
        totalParticipants: tour.participants.size
      }));
    }
  }

  // Confirmar conexión
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
    
    // Notificar a todos los participantes que el guía se desconectó
    tour.participants.forEach(participant => {
      participant.send(JSON.stringify({
        type: 'guide-left',
        tourId
      }));
    });

  } else if (role === 'participant') {
    tour.participants.delete(ws);
    console.log(`Participant ${userId} left tour ${tourId} (${tour.participants.size} remaining)`);
    
    // Notificar al guía
    if (tour.guide) {
      tour.guide.send(JSON.stringify({
        type: 'participant-left',
        tourId,
        participantId: userId,
        totalParticipants: tour.participants.size
      }));
    }
  }

  // Limpiar tour vacío
  if (!tour.guide && tour.participants.size === 0) {
    tours.delete(tourId);
    console.log(`Tour ${tourId} deleted (empty)`);
  }

  connections.delete(ws);
}

function relayToParticipants(ws, data) {
  const connection = connections.get(ws);
  if (!connection || connection.role !== 'guide') {
    ws.send(JSON.stringify({ type: 'error', message: 'Only guides can send offers' }));
    return;
  }

  const tour = tours.get(connection.tourId);
  if (!tour) return;

  // Relay offer a todos los participantes
  const message = JSON.stringify({
    type: 'offer',
    tourId: data.tourId,
    offer: data.offer,
    guideId: connection.userId
  });

  tour.participants.forEach(participant => {
    participant.send(message);
  });

  console.log(`Relayed offer from guide to ${tour.participants.size} participants`);
}

function relayToGuide(ws, data) {
  const connection = connections.get(ws);
  if (!connection || connection.role !== 'participant') {
    ws.send(JSON.stringify({ type: 'error', message: 'Only participants can send answers' }));
    return;
  }

  const tour = tours.get(connection.tourId);
  if (!tour || !tour.guide) return;

  // Relay answer al guía
  tour.guide.send(JSON.stringify({
    type: 'answer',
    tourId: data.tourId,
    answer: data.answer,
    participantId: connection.userId
  }));

  console.log(`Relayed answer from participant ${connection.userId} to guide`);
}

function relayIceCandidate(ws, data) {
  const connection = connections.get(ws);
  if (!connection) return;

  const tour = tours.get(connection.tourId);
  if (!tour) return;

  const message = JSON.stringify({
    type: 'ice-candidate',
    tourId: data.tourId,
    candidate: data.candidate,
    fromId: connection.userId,
    fromRole: connection.role
  });

  if (connection.role === 'guide') {
    // Relay ICE candidate a todos los participantes
    tour.participants.forEach(participant => {
      participant.send(message);
    });
  } else {
    // Relay ICE candidate al guía
    if (tour.guide) {
      tour.guide.send(message);
    }
  }
}

function handleDisconnection(ws) {
  console.log('Client disconnected');
  leaveTour(ws);
}

// Cleanup de conexiones muertas cada 30 segundos
setInterval(() => {
  const deadConnections = [];
  
  connections.forEach((connection, ws) => {
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (error) {
      deadConnections.push(ws);
    }
  });

  deadConnections.forEach(ws => {
    handleDisconnection(ws);
  });

  if (deadConnections.length > 0) {
    console.log(`Cleaned up ${deadConnections.length} dead connections`);
  }
}, 30000);

console.log(`🚀 Signaling server running on port ${server.port}`);
console.log(`WebSocket endpoint: ws://localhost:${server.port}/ws`);
console.log(`Health check: http://localhost:${server.port}/health`);
