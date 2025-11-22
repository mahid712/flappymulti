const WebSocket = require('ws');
const http = require('http'); // 1. Import the standard HTTP module

// --- SERVER INITIALIZATION ---
// NOTE: For deployment on platforms like Render, you must use process.env.PORT || 8080
const port = process.env.PORT || 8080;

// 2. CREATE A BASIC HTTP SERVER (Required for routing on cloud platforms)
const server = http.createServer((req, res) => {
    // This server handles the port binding but doesn't need to serve any files
    res.writeHead(200);
    res.end('WebSocket server is active.');
});

// 3. ATTACH WSS TO THE HTTP SERVER
// CRITICAL: We use 'server' here, NOT 'port'.
const wss = new WebSocket.Server({ server: server });

// 4. START THE HTTP SERVER LISTENING
server.listen(port, () => {
    console.log(`Server listening on port ${port}. WebSocket readiness confirmed.`);
});
// -----------------------------

// Use a Map for efficiency and clarity
let rooms = new Map();
let clientIdCounter = 1;


// --- ROOM AND CLIENT CLEANUP FUNCTION ---
const removeClientFromRoom = (client_ws) => {
    // Get the room code before it's potentially cleared
    const code = client_ws.roomCode; 

    if (code && rooms.has(code)) {
        const roomClients = rooms.get(code);
        
        // 1. Notify the remaining player that the opponent left
        for (const other_client_ws of roomClients.values()) {
            // Check if client is still open and is NOT the one leaving
            if (other_client_ws.id !== client_ws.id && other_client_ws.readyState === WebSocket.OPEN) {
                other_client_ws.send(JSON.stringify({ type: 'opponentLeft' }));
                console.log(`Opponent Left. Notifying client ${other_client_ws.id} in room ${code}`);
            }
        }
        
        // 2. Remove the client from the roomClients Map
        roomClients.delete(client_ws.id); 
        client_ws.roomCode = null; // Clear room code from the connection object
        
        // 3. Check if the room is now empty
        if (roomClients.size === 0) {
            rooms.delete(code);
            console.log(`Room ${code} deleted as it is empty.`);
        } else {
            // Log that the room still exists with one player
            console.log(`Client ${client_ws.id} disconnected/left room ${code}. Room size: ${roomClients.size}`);
        }
    } else {
        console.log(`Client ${client_ws.id} disconnected.`);
    }
};


wss.on('connection', ws => {
    // 1. Assign a unique ID to the client immediately
    ws.id = (clientIdCounter++).toString();
    
    // Send the ID back to the client
    ws.send(JSON.stringify({ type: 'assignId', id: ws.id }));
    console.log(`New Client Connected. Assigned ID: ${ws.id}`); // Log connection

    // --- MESSAGE HANDLER ---
    ws.on('message', message => {
        let data;
        
        // Safety check 1: Parsing
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Failed to parse incoming JSON message:', message, e);
            return; 
        }

        // Safety check 2: Processing logic
        try {

            // --- ROOM MANAGEMENT ---
            if(data.type === 'createRoom'){
                // Generate a 4-digit room code
                const code = Math.floor(1000 + Math.random()*9000).toString();
                
                // Room Map: { 'CLIENT_ID': WebSocket_Object }
                rooms.set(code, new Map([[ws.id, ws]]));  
                ws.roomCode = code;
                ws.send(JSON.stringify({ type: 'roomCreated', code }));
                console.log(`Room Created: ${code} by client ${ws.id}`);
            }

            if(data.type === 'joinRoom'){
                const roomClients = rooms.get(data.code);

                if(roomClients && roomClients.size === 1){
                    // Add the new player (P2) to the room
                    roomClients.set(ws.id, ws);
                    ws.roomCode = data.code;
                    ws.send(JSON.stringify({ type: 'roomJoined', code: data.code }));

                    // Notify the room owner (P1) that P2 has joined
                    const p1_ws = roomClients.values().next().value; 

                    // CRITICAL: Ensure P1 is still connected before sending.
                    if (p1_ws && p1_ws.readyState === WebSocket.OPEN) {
                        p1_ws.send(JSON.stringify({ type: 'playerJoined', code: data.code }));
                        console.log(`Client ${ws.id} joined room ${data.code}. Room now full.`);
                    } else {
                        // If P1 is gone, close P2's connection, as the room is invalid.
                        ws.send(JSON.stringify({ type: 'error', message: 'Room owner disconnected. Please try creating a new room.' }));
                        ws.close(1008, "Owner Disconnected");  
                        // Call cleanup on P1's old room entry
                        removeClientFromRoom(p1_ws);
                        return;
                    }
                } else {
                    // This handles 'room not found' (roomClients is null) or 'room full'
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found or full' }));
                }
            }
            
            // --- GAME STATE SYNCHRONIZATION ---
            if(data.type === 'playerUpdate'){
                const roomClients = rooms.get(data.code);
                const senderId = ws.id; 
                
                // Ensure room exists and has 2 players for synchronization
                if (roomClients && roomClients.size === 2) {
                    
                    const opponentMessage = JSON.stringify({
                        type: 'opponentUpdate', 
                        state: data.state
                    });

                    // Loop through all clients in the room to find the opponent
                    for (const client_ws of roomClients.values()) {
                        
                        // Send the update to the client whose ID is NOT the sender's ID
                        if (client_ws.id !== senderId) { 
                            if (client_ws.readyState === WebSocket.OPEN) {
                                client_ws.send(opponentMessage);
                                // console.log(`  -> Sent PUpdate to opponent: ${client_ws.id}`);
                            }
                        }
                    }
                }
            }
            
            // --- START GAME COMMAND ---
            if(data.type === 'startGame'){
                 const roomClients = rooms.get(data.code);
                 if(roomClients && roomClients.size === 2){
                     roomClients.forEach(client_ws => client_ws.send(JSON.stringify({ type: 'startGame' })));
                     console.log(`Start Game signal broadcasted for room ${data.code}`);
                 }
            }
            
            // --- LEAVE ROOM (CLIENT REQUEST) ---
            if(data.type === 'leaveRoom'){
                removeClientFromRoom(ws);
            }
            
        } catch (e) {
            // CRITICAL: Catch and log any processing error to prevent connection crash
            console.error(`ERROR processing message of type ${data.type} from client ${ws.id} in room ${ws.roomCode}:`, e);
            
            // Attempt to send an error message back to the client
            try {
                ws.send(JSON.stringify({ type: 'error', message: `Server internal error during ${data.type} processing. Check server logs.` }));
            } catch (sendError) {
                console.warn(`Failed to send error message back to client ${ws.id}.`, sendError);
            }
            
            // Gracefully close the connection if it's still open
            if(ws.readyState === WebSocket.OPEN) {
                ws.close(1011, "Internal Server Error"); 
            }
        }
    });

    // --- CONNECTION CLOSED HANDLER ---
    ws.on('close', () => {
        removeClientFromRoom(ws);
    });
});
