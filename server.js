const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

let rooms = {};

wss.on('connection', ws => {
    ws.on('message', message => {
        const data = JSON.parse(message);

        if(data.type === 'createRoom'){
            const code = Math.floor(1000 + Math.random()*9000).toString();
            rooms[code] = {players:[ws]};
            ws.roomCode = code;
            ws.send(JSON.stringify({type:'roomCreated', code}));
        }

        if(data.type === 'joinRoom'){
            const room = rooms[data.code];
            if(room && room.players.length === 1){
                room.players.push(ws);
                ws.roomCode = data.code;
                room.players.forEach(p=>p.send(JSON.stringify({type:'startGame'})));
            } else {
                ws.send(JSON.stringify({type:'error', message:'Room not found or full'}));
            }
        }
    });

    ws.on('close', ()=>{
        if(ws.roomCode && rooms[ws.roomCode]){
            delete rooms[ws.roomCode];
        }
    });
});

console.log("WebSocket server running on ws://localhost:8080");
