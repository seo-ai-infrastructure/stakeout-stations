package net.stakeout.duomove.player;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.*;
import android.view.ViewGroup;
import android.widget.*;
import java.util.Map;

public final class MainActivity extends Activity {
    private TextView status;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable refresh=new Runnable(){public void run(){
        StringBuilder text=new StringBuilder();
        for(Map.Entry<String,Object> e:PlayerService.snapshot().entrySet())text.append(e.getKey()).append(": ").append(e.getValue()).append("\n\n");
        status.setText(text);handler.postDelayed(this,500);
    }};
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout column=new LinearLayout(this);column.setOrientation(LinearLayout.VERTICAL);column.setPadding(28,32,28,24);column.setBackgroundColor(Color.rgb(245,247,250));
        TextView title=new TextView(this);title.setText(R.string.app_name);title.setTextSize(30);title.setTextColor(Color.rgb(20,35,55));column.addView(title);
        TextView note=new TextView(this);note.setText(R.string.playback_note);note.setTextSize(17);note.setPadding(0,16,0,20);column.addView(note);
        Button stop=new Button(this);stop.setText(R.string.stop_drive);stop.setOnClickListener(v->PlayerService.cancelDrive());column.addView(stop);
        ScrollView scroll=new ScrollView(this);status=new TextView(this);status.setTextSize(17);status.setTextIsSelectable(true);scroll.addView(status);column.addView(scroll,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1));
        setContentView(column);
        if(checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION},10);
        }else startPlayer();
    }
    private void startPlayer(){startForegroundService(new Intent(this,PlayerService.class));}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){
        super.onRequestPermissionsResult(request,permissions,results);
        if(checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED)startPlayer();
    }
    @Override public void onResume(){super.onResume();handler.post(refresh);}
    @Override public void onPause(){handler.removeCallbacks(refresh);super.onPause();}
}
