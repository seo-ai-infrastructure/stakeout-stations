package net.stakeout.duomove.player;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;
import android.util.Base64;
import net.stakeout.duomove.core.Playback;
import net.stakeout.duomove.core.PlanJson;

/** Loopback only; bounded messages and clients; token never appears in logs. */
final class ControlServer implements AutoCloseable {
    private final Playback playback;
    private final AndroidSink sink;
    private final byte[] token;
    private final String instance=UUID.randomUUID().toString();
    private final ServerSocket server;
    private final Set<Socket> sockets=ConcurrentHashMap.newKeySet();
    private final ThreadPoolExecutor workers=new ThreadPoolExecutor(4,4,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(4));
    private volatile boolean running=true;
    ControlServer(Playback playback,AndroidSink sink,String token) throws IOException {
        this.playback=playback;this.sink=sink;this.token=token.getBytes(StandardCharsets.UTF_8);
        server=new ServerSocket();server.setReuseAddress(true);
        server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),9999),8);
    }
    void serve() {
        while(running) {
            try {
                Socket socket=server.accept();socket.setSoTimeout(4000);socket.setTcpNoDelay(true);sockets.add(socket);
                try{workers.execute(()->client(socket));}catch(RejectedExecutionException e){sockets.remove(socket);socket.close();}
            }catch(IOException e){if(running)android.util.Log.e("duomove_player","accept_failed");}
        }
    }
    private String line(InputStream in) throws IOException {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        for(int i=0;i<131072;i++) {
            int b=in.read();if(b<0){if(bytes.size()==0)return null;throw new IOException("incomplete_line");}
            if(b=='\n')return bytes.toString(StandardCharsets.UTF_8.name());
            bytes.write(b);
        }
        throw new IOException("message_too_large");
    }
    private void client(Socket socket) {
        boolean authenticated=false;
        try(Socket owned=socket;InputStream in=new BufferedInputStream(socket.getInputStream());OutputStream out=socket.getOutputStream()) {
            String text;
            while((text=line(in))!=null) {
                JSONObject response=new JSONObject();String id="";
                try {
                    JSONObject request=PlanJson.object(text);id=request.getString("id");
                    if(!id.matches("[0-9a-f]{32}"))throw new IllegalArgumentException("invalid_request_id");
                    String op=request.getString("op");Map<String,Object> result;
                    if(!authenticated) {
                        if(!op.equals("auth")||PlanJson.integer(request,"version",1,1)!=1||
                           !MessageDigest.isEqual(token,request.getString("token").getBytes(StandardCharsets.UTF_8)))throw new SecurityException();
                        authenticated=true;result=playback.status();
                    }else {
                        String session=request.optString("session_id","");
                        switch(op) {
                            case "prepare":result=playback.prepare(session,(int)PlanJson.integer(request,"size",2,Playback.MAX_BYTES),request.getString("sha256"));break;
                            case "append":result=playback.append(session,(int)PlanJson.integer(request,"offset",0,Playback.MAX_BYTES),Base64.decode(request.getString("data"),Base64.NO_WRAP));break;
                            case "commit":result=playback.commit(session);break;
                            case "start":result=playback.start(session);break;
                            case "heartbeat":result=playback.heartbeat(session);break;
                            case "cancel":result=playback.cancel(session);break;
                            case "status":result=playback.status();break;
                            default:throw new IllegalArgumentException("unknown_operation");
                        }
                    }
                    response=new JSONObject(result);response.put("ok",true);response.put("instance_id",instance);
                    for(Map.Entry<String,Object> item:sink.observations().entrySet())response.put(item.getKey(),item.getValue());
                }catch(SecurityException e){response.put("ok",false);response.put("error","unauthorized");}
                catch(Exception e){response.put("ok",false);response.put("error",safe(e));}
                response.put("id",id);out.write((response.toString()+"\n").getBytes(StandardCharsets.UTF_8));out.flush();
                if(!authenticated)break;
            }
        }catch(Exception ignored){}finally{sockets.remove(socket);}
    }
    private String safe(Exception e) {
        String message=e.getMessage();
        return e instanceof IllegalArgumentException && message!=null && message.matches("[a-z_]{1,80}")?message:"invalid_request";
    }
    @Override public void close() {
        running=false;try{server.close();}catch(IOException ignored){}
        for(Socket s:sockets)try{s.close();}catch(IOException ignored){}
        workers.shutdownNow();
    }
}
