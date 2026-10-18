// Lets HTTP routes reach connected sockets (set once the Socket.IO server starts).
let io = null;
export function setIo(server) { io = server; }
export function getIo() { return io; }

export function emitToUser(userId, event, payload) {
  io?.to(`u:${userId}`).emit(event, payload);
}
