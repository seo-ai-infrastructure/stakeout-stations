package net.stakeout.duomove.core;

import java.security.MessageDigest;
import java.util.*;

/** One writer, monotonic lease, idempotent commands, and no catch-up bursts. */
public final class Playback {
    public interface Clock { long nanos(); long wallMillis(); }
    public interface Sink {
        void open() throws Exception;
        void apply(Sample sample,long elapsedNanos,long wallMillis,String session) throws Exception;
        void close() throws Exception;
    }
    public interface Decoder { Plan decode(byte[] bytes) throws Exception; }
    public static final long LEASE_NS=15_000_000_000L;
    public static final int MAX_BYTES=8_000_000;
    private final Clock clock;
    private final Sink sink;
    private final Decoder decoder;
    private final Set<String> retired=new LinkedHashSet<>();
    private String session="",sha="",state="IDLE",error="";
    private byte[] upload;
    private int received,size,applied=-1,skipped;
    private long expires,startNanos,startWall,maxLateMs;
    private Plan plan;
    private boolean sinkOpened,cleanupOk=true;

    public Playback(Clock clock,Sink sink,Decoder decoder){this.clock=clock;this.sink=sink;this.decoder=decoder;}
    private boolean terminal(){return Arrays.asList("COMPLETED","CANCELLED","EXPIRED","FAILED").contains(state);}
    private boolean active(){return !session.isEmpty()&&!terminal();}
    private void expiry(){if(active()&&clock.nanos()>=expires)finish("EXPIRED","control_lease_expired");}
    private void require(String id){expiry();if(!session.equals(id))throw new IllegalArgumentException("session_mismatch");}
    private void renew(){expires=clock.nanos()+LEASE_NS;}

    public synchronized Map<String,Object> prepare(String id,int bytes,String digest) {
        expiry();
        if(!UUID.fromString(id).toString().equals(id)||bytes<2||bytes>MAX_BYTES||!digest.matches("[0-9a-f]{64}"))throw new IllegalArgumentException("invalid_prepare");
        if(session.equals(id)) {
            if(size!=bytes||!sha.equals(digest))throw new IllegalArgumentException("session_content_conflict");
            if(!terminal())renew();
            return status();
        }
        if(active())throw new IllegalArgumentException("device_busy");
        if(retired.contains(id))throw new IllegalArgumentException("retired_session");
        if(!session.isEmpty())retired.add(session);
        if(retired.size()>256)retired.remove(retired.iterator().next());
        if(!cleanupOk)throw new IllegalArgumentException("provider_cleanup_failed_restart_player");
        session=id;size=bytes;sha=digest;upload=new byte[bytes];received=0;applied=-1;skipped=0;
        maxLateMs=0;startNanos=0;startWall=0;error="";state="UPLOADING";plan=null;renew();
        return status();
    }

    public synchronized Map<String,Object> append(String id,int offset,byte[] chunk) {
        require(id);
        if(!state.equals("UPLOADING"))throw new IllegalArgumentException("not_uploading");
        if(offset<0||chunk.length==0||chunk.length>48000||offset>received||offset+chunk.length>size)throw new IllegalArgumentException("invalid_chunk");
        if(offset<received) {
            if(offset+chunk.length>received)throw new IllegalArgumentException("overlapping_chunk");
            for(int i=0;i<chunk.length;i++)if(upload[offset+i]!=chunk[i])throw new IllegalArgumentException("changed_chunk");
        } else {
            System.arraycopy(chunk,0,upload,offset,chunk.length);received+=chunk.length;
        }
        renew();return status();
    }

    public synchronized Map<String,Object> commit(String id) {
        require(id);
        if(terminal()||state.equals("READY")||state.equals("RUNNING")||state.equals("DWELL"))return status();
        if(received!=size)throw new IllegalArgumentException("incomplete_upload");
        try {
            byte[] hash=MessageDigest.getInstance("SHA-256").digest(upload);
            StringBuilder hex=new StringBuilder();for(byte b:hash)hex.append(String.format(Locale.ROOT,"%02x",b&255));
            if(!sha.equals(hex.toString()))throw new IllegalArgumentException("plan_checksum");
            plan=decoder.decode(upload);upload=null;state="READY";renew();
        }catch(Exception failure){finish("FAILED","plan_validation_failed");}
        return status();
    }

    public synchronized Map<String,Object> start(String id) {
        require(id);
        if(terminal()||state.equals("RUNNING")||state.equals("DWELL"))return status();
        if(!state.equals("READY"))throw new IllegalArgumentException("plan_not_ready");
        try {
            // Mark first: a partially successful open still needs cleanup.
            sinkOpened=true;sink.open();
            startNanos=clock.nanos()+500_000_000L;startWall=clock.wallMillis()+500;
            state="RUNNING";renew();
        }catch(Exception failure){finish("FAILED","provider_setup_failed");}
        return status();
    }

    public synchronized Map<String,Object> heartbeat(String id){require(id);if(!terminal())renew();return status();}
    public synchronized Map<String,Object> cancel(String id){require(id);if(!terminal())finish("CANCELLED","");return status();}
    public synchronized void shutdown(){if(active())finish("CANCELLED","player_stopped");}

    public synchronized void tick() {
        expiry();
        if(!(state.equals("RUNNING")||state.equals("DWELL")))return;
        long now=clock.nanos();
        if(now<startNanos)return;
        int due=(int)Math.min(plan.size()-1,(now-startNanos)/1_000_000_000L);
        if(due<=applied)return;
        // More than two missed intervals is a stall, not permission to teleport.
        if(due-applied>3){finish("FAILED","playback_stalled");return;}
        Sample sample=plan.get(due);
        long scheduled=startNanos+sample.timeMs*1_000_000L;
        if(now-scheduled>2_500_000_000L){finish("FAILED","playback_stalled");return;}
        maxLateMs=Math.max(maxLateMs,(now-scheduled)/1_000_000L);
        try {
            sink.apply(sample,scheduled,startWall+sample.timeMs,session);
            skipped+=due-applied-1;applied=due;
            state=sample.phase.equals("dwell")?"DWELL":"RUNNING";
            if(due==plan.size()-1)finish("COMPLETED","");
        }catch(Exception failure){finish("FAILED","provider_apply_failed");}
    }

    private void finish(String terminalState,String why) {
        state=terminalState;error=why;upload=null;plan=null;
        if(sinkOpened){try{sink.close();}catch(Exception failure){cleanupOk=false;error="provider_cleanup_failed";state="FAILED";}finally{sinkOpened=false;}}
    }

    public synchronized Map<String,Object> status() {
        expiry();
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("session_id",session);result.put("state",state);result.put("received_bytes",received);
        result.put("applied_seq",applied);result.put("skipped_samples",skipped);result.put("max_lateness_ms",maxLateMs);
        result.put("start_elapsed_nanos",startNanos);result.put("lease_remaining_ms",active()?Math.max(0,(expires-clock.nanos())/1_000_000L):0);
        result.put("cleanup_ok",cleanupOk);result.put("error",error);
        return result;
    }
}
