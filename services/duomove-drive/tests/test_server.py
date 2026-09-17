import socket
from duomove_drive.server import bind_http_socket


def test_listener_serves_ipv4_and_railway_ipv6():
    with bind_http_socket(0) as listener:
        listener.settimeout(2)
        port=listener.getsockname()[1]
        hosts=['127.0.0.1']+(['::1'] if socket.has_dualstack_ipv6() else [])
        for host in hosts:
            with socket.create_connection((host,port),timeout=2) as client:
                with listener.accept()[0] as accepted:
                    accepted.sendall(b'ready')
                    assert client.recv(5)==b'ready'
