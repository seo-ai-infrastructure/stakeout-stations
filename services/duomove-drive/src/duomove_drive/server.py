"""One HTTP worker on IPv4 and IPv6 for Railway private networking."""
import os
import socket


def bind_http_socket(port: int) -> socket.socket:
    if socket.has_dualstack_ipv6():
        return socket.create_server(("::",port),family=socket.AF_INET6,dualstack_ipv6=True)
    return socket.create_server(("0.0.0.0",port))


def serve():
    import uvicorn
    config=uvicorn.Config("duomove_drive.service:create_app",factory=True,workers=1,timeout_graceful_shutdown=20)
    with bind_http_socket(int(os.environ.get("PORT","8000"))) as listener:
        uvicorn.Server(config).run(sockets=[listener])
