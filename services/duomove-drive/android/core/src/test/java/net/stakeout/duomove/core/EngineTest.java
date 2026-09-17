package net.stakeout.duomove.core;

import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

public final class EngineTest {
    private static int assertions;
    private static void check(boolean value,String message){assertions++;if(!value)throw new AssertionError(message);}
    private static final class Clock implements Playback.Clock {
        long now=1_000_000_000L,wall=1_700_000_000_000L;
        public long nanos(){return now;}public long wallMillis(){return wall;}
        void add(long ms){now+=ms*1_000_000L;wall+=ms;}
    }
    private static final class Sink implements Playback.Sink {
        int opened,applied,closed;long lastStamp;boolean failApply,failClose;
        public void open(){opened++;}
        public void apply(Sample s,long elapsed,long wall,String session){if(failApply)throw new IllegalStateException();applied++;check(elapsed>lastStamp,"monotonic sample timestamps");lastStamp=elapsed;}
        public void close(){closed++;if(failClose)throw new IllegalStateException();}
    }
    private static byte[] data;
    private static String sha;
    private static Playback ready(Clock c,Sink sink,String id) {
        Playback p=new Playback(c,sink,PlanJson::decode);
        p.prepare(id,data.length,sha);p.append(id,0,data);p.commit(id);
        check(p.status().get("state").equals("READY"),"Python fixture accepted by Java decoder");return p;
    }
    public static void main(String[] args) throws Exception {
        data=Files.readAllBytes(Paths.get(System.getProperty("duomove.fixture")));
        check(data.length<48000,"single test upload chunk");
        StringBuilder digest=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))digest.append(String.format("%02x",b&255));sha=digest.toString();
        Plan plan=PlanJson.decode(data);check(plan.get(0).speed==0&&plan.get(plan.size()-1).speed==0,"fixture stopped endpoints");
        {
            Clock c=new Clock();Sink sink=new Sink();String id=UUID.randomUUID().toString();Playback p=ready(c,sink,id);
            p.start(id);Object start=p.status().get("start_elapsed_nanos");c.add(100);p.start(id);
            check(sink.opened==1&&p.status().get("start_elapsed_nanos").equals(start),"lost start ACK cannot restart");
            c.add(400);p.tick();check(sink.applied==1,"first sample at anchor");
            c.add(1000);p.tick();check(sink.applied==2,"second sample at absolute deadline");
            c.add(15001);p.tick();check(p.status().get("state").equals("EXPIRED")&&sink.closed==1,"lease expiry stops providers");
            p.heartbeat(id);p.start(id);check(sink.opened==1,"expired session cannot resume");
        }
        {
            Clock c=new Clock();Sink sink=new Sink();String id=UUID.randomUUID().toString();Playback p=ready(c,sink,id);
            p.start(id);c.add(500);p.tick();c.add(2000);p.tick();
            check(sink.applied==2&&p.status().get("skipped_samples").equals(1),"late tick skips samples without burst");
            c.add(4000);p.tick();check(p.status().get("state").equals("FAILED"),"scheduler stall fails closed");
        }
        {
            Clock c=new Clock();Sink sink=new Sink();String id=UUID.randomUUID().toString();Playback p=ready(c,sink,id);
            p.start(id);c.add(500);
            for(int i=0;i<plan.size();i++){p.heartbeat(id);p.tick();c.add(1000);}
            check(p.status().get("state").equals("COMPLETED")&&sink.closed==1,"arrival dwell completes and cleans up");
            check(sink.applied==plan.size(),"all nominal samples applied exactly once");
        }
        {
            Clock c=new Clock();Sink sink=new Sink();String id=UUID.randomUUID().toString();Playback p=ready(c,sink,id);
            p.start(id);sink.failApply=true;c.add(500);p.tick();
            check(p.status().get("state").equals("FAILED")&&sink.closed==1,"provider failure cannot report completed");
        }
        {
            Clock c=new Clock();Sink sink=new Sink();String id=UUID.randomUUID().toString();Playback p=ready(c,sink,id);
            p.start(id);sink.failClose=true;p.cancel(id);
            check(p.status().get("cleanup_ok").equals(false),"cleanup failure visible");
            boolean blocked=false;try{p.prepare(UUID.randomUUID().toString(),data.length,sha);}catch(IllegalArgumentException e){blocked=true;}
            check(blocked,"failed cleanup prevents new drive");
        }
        {
            Clock c=new Clock();Sink sink=new Sink();String id=UUID.randomUUID().toString();Playback p=new Playback(c,sink,PlanJson::decode);
            p.prepare(id,data.length,sha);p.append(id,0,data);p.append(id,0,data);
            check(p.status().get("received_bytes").equals(data.length),"duplicate append is idempotent");
            byte[] changed=data.clone();changed[0]^=1;boolean rejected=false;
            try{p.append(id,0,changed);}catch(IllegalArgumentException e){rejected=true;}
            check(rejected,"changed replay rejected");
            p.cancel(id);String next=UUID.randomUUID().toString();p.prepare(next,data.length,sha);
            rejected=false;try{p.heartbeat(id);}catch(IllegalArgumentException e){rejected=true;}
            check(rejected,"old session cannot renew new owner's lease");
        }
        System.out.println("PASS: "+assertions+" Java playback and Python-to-Java contract assertions");
    }
}
