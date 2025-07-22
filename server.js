// server.js - Signaling Server Fixed
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
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 500, headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      const body = JSON.stringify({ 
        status: 'ok', 
        tours: tours.size,
        connections: connections.size,
        timestamp: new Date().toISOString()
      });
      return new Response(body, { 
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    return new Response("WebRTC Signaling Server v2.0", { 
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
      console.log('Unknown message type:', type);
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

function joinTour(ws, tourId, userId, role) {
  console.log(`${role} ${userId} attempting to join tour ${tourId}`);
  
  // Limpiar conexión anterior
  leaveTour(ws);

  // Crear tour si no existe
  if (!tours.has(tourId)) {
    tours.set(tourId, { guide: null, participants: new Set() });
    console.log(`Created new tour: ${tourId}`);
  }

  const tour = tours.get(tourId);
  connections.set(ws, { userId, tourId, role });

  if (role === 'guide') {
    if (tour.guide) {
      console.log(`Tour ${tourId} already has a guide`);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Tour already has a guide' 
      }));
      connections.delete(ws);
      return;
    }
    
    tour.guide = ws;
    console.log(`Guide ${userId} joined tour ${tourId}`);
    
    // Notificar a participantes existentes
    tour.participants.forEach(participant => {
      try {
        participant.send(JSON.stringify({
          type: 'guide-joined',
          tourId,
          guideId: userId
        }));
      } catch (e) {
        console.error('Error notifying participant:', e);
      }
    });

  } else if (role === 'participant') {
    tour.participants.add(ws);
    console.log(`Participant ${userId} joined tour ${tourId} (${tour.participants.size} total)`);
    
    // Notificar al guía si existe
    if (tour.guide) {
      try {
        tour.guide.send(JSON.stringify({
          type: 'participant-joined',
          tourId,
          participantId: userId,
          totalParticipants: tour.participants.size
        }));
      } catch (e) {
        console.error('Error notifying guide:', e);
      }
    }
  }

  // IMPORTANTE: Confirmar que se unió correctamente
  ws.send(JSON.stringify({
    type: 'joined-tour',
    tourId,
    role,
    userId,
    participantCount: tour.participants.size,
    hasGuide: !!tour.guide,
    success: true
  }));
}

function leaveTour(ws) {
  const connection = connections.get(ws);
  if (!connection) return;

  const { userId, tourId, role } = connection;
  const tour = tours.get(tourId);
  
  if (!tour) {
    connections.delete(ws);
    return;
  }

  console.log(`${role} ${userId} leaving tour ${tourId}`);

  if (role === 'guide' && tour.guide === ws) {
    tour.guide = null;
    
    // Notificar a todos los participantes
    tour.participants.forEach(participant => {
      try {
        participant.send(JSON.stringify({
          type: 'guide-left',
          tourId
        }));
      } catch (e) {
        console.error('Error notifying participant:', e);
      }
    });

  } else if (role === 'participant') {
    tour.participants.delete(ws);
    
    // Notificar al guía
    if (tour.guide) {
      try {
        tour.guide.send(JSON.stringify({
          type: 'participant-left',
          tourId,
          participantId: userId,
          totalParticipants: tour.participants.size
        }));
      } catch (e) {
        console.error('Error notifying guide:', e);
      }
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

  console.log(`Relaying offer from guide to ${tour.participants.size} participants`);

  // Relay offer a todos los participantes
  const message = JSON.stringify({
    type: 'offer',
    tourId: data.tourId,
    offer: data.offer,
    guideId: connection.userId
  });

  let successCount = 0;
  tour.participants.forEach(participant => {
    try {
      participant.send(message);
      successCount++;
    } catch (e) {
      console.error('Error sending offer to participant:', e);
    }
  });

  console.log(`Offer sent to ${successCount}/${tour.participants.size} participants`);
}

function relayToGuide(ws, data) {
  const connection = connections.get(ws);
  if (!connection || connection.role !== 'participant') {
    ws.send(JSON.stringify({ type: 'error', message: 'Only participants can send answers' }));
    return;
  }

  const tour = tours.get(connection.tourId);
  if (!tour || !tour.guide) {
    console.log('No guide found for answer relay');
    return;
  }

  console.log(`Relaying answer from participant ${connection.userId} to guide`);

  // Relay answer al guía
  try {
    tour.guide.send(JSON.stringify({
      type: 'answer',
      tourId: data.tourId,
      answer: data.answer,
      participantId: connection.userId
    }));
  } catch (e) {
    console.error('Error relaying answer to guide:', e);
  }
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

  let targets = 0;
  if (connection.role === 'guide') {
    // Relay ICE candidate a todos los participantes
    tour.participants.forEach(participant => {
      try {
        participant.send(message);
        targets++;
      } catch (e) {
        console.error('Error sending ICE candidate to participant:', e);
      }
    });
  } else {
    // Relay ICE candidate al guía
    if (tour.guide) {
      try {
        tour.guide.send(message);
        targets++;
      } catch (e) {
        console.error('Error sending ICE candidate to guide:', e);
      }
    }
  }

  console.log(`ICE candidate from ${connection.role} ${connection.userId} sent to ${targets} targets`);
}

function handleDisconnection(ws) {
  console.log('Client disconnected');
  leaveTour(ws);
}

// Cleanup de conexiones muertas cada 30 segundos
setInterval(() => {
  let cleaned = 0;
  connections.forEach((connection, ws) => {
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (error) {
      handleDisconnection(ws);
      cleaned++;
    }
  });

  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} dead connections`);
  }
}, 30000);

console.log(`🚀 Signaling server running on port ${server.port}`);
console.log(`WebSocket endpoint: ws://localhost:${server.port}/ws`);
console.log(`Health check: http://localhost:${server.port}/health`);