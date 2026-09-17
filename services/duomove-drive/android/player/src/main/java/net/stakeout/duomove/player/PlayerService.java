package net.stakeout.duomove.player;

import android.app.*;
import android.content.Intent;
import android.os.*;
import android.util.Log;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import net.stakeout.duomove.core.Playback;
import net.stakeout.duomove.core.PlanJson;

public final class PlayerService extends Service {
    private static volatile PlayerService instance;
    private static volatile String startup="Player stopped";
    private static volatile Map<String,Object> latest=Collections.emptyMap();
    private Playback playback;
    private AndroidSink sink;
    private ControlServer server;
    private volatile boolean closing;
    private final ScheduledExecutorService ticker=Executors.newSingleThreadScheduledExecutor();
    @Override public void onCreate() {
        super.onCreate();instance=this;latest=Collections.emptyMap();startup="Checking player and recovering providers";
        NotificationManager notifications=getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("drive","Drive playback",NotificationManager.IMPORTANCE_LOW));
        Intent open=new Intent(this,MainActivity.class);
        PendingIntent pending=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        startForeground(1,new Notification.Builder(this,"drive").setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("DuoMove Drive").setContentText("Controlled synthetic location playback").setContentIntent(pending).build());
        ticker.execute(this::initialize);
    }
    private void initialize() {
        try {
            File file=new File(getFilesDir(),"control-token");
            if(!file.isFile()||file.length()>128)throw new IllegalStateException();
            String token=new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8).trim();
            if(!token.matches("[A-Za-z0-9_-]{32,128}"))throw new IllegalStateException();
            sink=new AndroidSink(this);
            sink.recoverInterrupted();
            if(closing)return;
            playback=new Playback(new Playback.Clock(){public long nanos(){return SystemClock.elapsedRealtimeNanos();}public long wallMillis(){return System.currentTimeMillis();}},sink,PlanJson::decode);
            server=new ControlServer(playback,sink,token);
            if(closing){server.close();return;}
            new Thread(server::serve,"duomove-control").start();
            ticker.scheduleWithFixedDelay(()->{try{
                playback.tick();Map<String,Object> value=playback.status();value.putAll(sink.observations());latest=value;
            }catch(Exception e){Log.e("duomove_player","tick_failed");playback.shutdown();}},0,20,TimeUnit.MILLISECONDS);
            startup="Ready on device loopback :9999";
            Log.i("duomove_player","ready protocol=1");
        }catch(Exception e){startup="Setup or provider recovery failed: check permissions and reopen player";Log.e("duomove_player","startup_failed");stopSelf();}
    }
    static Map<String,Object> snapshot() {
        Map<String,Object> value=new LinkedHashMap<>();value.put("player",startup);
        value.putAll(latest); // Never wait for provider/engine locks on Android's main thread.
        return value;
    }
    static void cancelDrive() {
        PlayerService current=instance;
        if(current!=null&&current.playback!=null&&!current.closing)try{current.ticker.execute(current.playback::shutdown);}catch(RejectedExecutionException ignored){}
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){return START_NOT_STICKY;}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onDestroy() {
        closing=true;instance=null;
        if(server!=null)server.close();
        // Provider operations must not await Google Tasks on Android's main thread.
        ticker.execute(()->{if(playback!=null)playback.shutdown();});ticker.shutdown();
        super.onDestroy();
    }
}
