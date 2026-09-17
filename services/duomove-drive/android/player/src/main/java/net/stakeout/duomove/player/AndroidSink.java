package net.stakeout.duomove.player;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.location.*;
import android.location.LocationListener;
import android.location.provider.ProviderProperties;
import android.os.*;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailabilityLight;
import com.google.android.gms.location.*;
import com.google.android.gms.tasks.Tasks;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import net.stakeout.duomove.core.*;

/** Supported mock-location delivery. The platform's mock markers are preserved. */
@SuppressLint("MissingPermission")
final class AndroidSink implements Playback.Sink {
    private final Context context;
    private final LocationManager manager;
    private final PowerManager.WakeLock wake;
    private final SharedPreferences journal;
    private FusedLocationProviderClient fused;
    private boolean fusedTouched;
    private final List<String> installed=new ArrayList<>();
    private volatile String activeSession="",delivery="not_started";
    private volatile int frameworkObserved=-1,fusedObserved=-1;
    private volatile long observedElapsed;
    private final Map<Integer,Expected> expected=new ConcurrentHashMap<>();
    private final AtomicInteger mismatches=new AtomicInteger();
    private static final class Expected {
        final Sample sample;final long elapsed,wall;
        Expected(Sample sample,long elapsed,long wall){this.sample=sample;this.elapsed=elapsed;this.wall=wall;}
    }
    private final LocationListener listener=new LocationListener() {
        @Override public void onLocationChanged(Location location){observe(location,false);}
        @Override public void onStatusChanged(String provider,int status,Bundle extras){}
        @Override public void onProviderEnabled(String provider){}
        @Override public void onProviderDisabled(String provider){}
    };
    private final LocationCallback callback=new LocationCallback() {
        @Override public void onLocationResult(LocationResult result){for(Location l:result.getLocations())observe(l,true);}
    };
    AndroidSink(Context context) {
        this.context=context;
        journal=context.getSharedPreferences("provider-ownership",Context.MODE_PRIVATE);
        manager=(LocationManager)context.getSystemService(Context.LOCATION_SERVICE);
        wake=((PowerManager)context.getSystemService(Context.POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"DuoMove:Drive");
        wake.setReferenceCounted(false);
    }
    private void owned(String provider,boolean value) {
        if(!journal.edit().putBoolean(provider,value).commit())throw new IllegalStateException("ownership_journal_failed");
    }
    /** A killed process stops emitting fixes; clean up its owned providers before accepting commands. */
    void recoverInterrupted() throws Exception {
        for(String provider:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER})
            if(journal.getBoolean(provider,false))installed.add(provider);
        if(journal.getBoolean("fused",false)) {
            fused=LocationServices.getFusedLocationProviderClient(context);fusedTouched=true;
        }
        if(!installed.isEmpty()||fusedTouched)close();
    }
    @Override public void open() throws Exception {
        frameworkObserved=fusedObserved=-1;observedElapsed=0;activeSession="";expected.clear();mismatches.set(0);
        wake.acquire(14_600_000L);
        for(String provider:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER}) {
            owned(provider,true);installed.add(provider);
            // Compile-time integer constants retain the legacy API 29 values.
            manager.addTestProvider(provider,false,false,false,false,true,true,true,ProviderProperties.POWER_USAGE_LOW,ProviderProperties.ACCURACY_FINE);
            manager.setTestProviderEnabled(provider,true);
            manager.requestLocationUpdates(provider,0,0,listener,Looper.getMainLooper());
        }
        if(GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context)==ConnectionResult.SUCCESS) {
            fused=LocationServices.getFusedLocationProviderClient(context);
            owned("fused",true);fusedTouched=true;
            Tasks.await(fused.setMockMode(true),2,TimeUnit.SECONDS);
            com.google.android.gms.location.LocationRequest request=new com.google.android.gms.location.LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY,1000)
                .setMinUpdateIntervalMillis(0).setMaxUpdateDelayMillis(0).build();
            Tasks.await(fused.requestLocationUpdates(request,callback,Looper.getMainLooper()),2,TimeUnit.SECONDS);
            delivery="framework_and_fused";
        }else delivery="framework_only_no_play_services";
    }
    private Location location(Sample sample,String provider,long elapsed,long wall,String session) {
        Location location=new Location(provider);
        location.setLatitude(sample.lat);location.setLongitude(sample.lon);location.setAccuracy((float)sample.accuracy);
        location.setSpeed((float)sample.speed);location.setBearing((float)sample.bearing);
        if(sample.altitude!=null)location.setAltitude(sample.altitude);
        location.setTime(wall);location.setElapsedRealtimeNanos(elapsed);
        Bundle extras=new Bundle();extras.putString("duomove_session",session);extras.putInt("duomove_seq",sample.seq);
        extras.putBoolean("duomove_synthetic",true);location.setExtras(extras);
        return location;
    }
    @Override public void apply(Sample sample,long elapsed,long wall,String session) throws Exception {
        activeSession=session;
        expected.put(sample.seq,new Expected(sample,elapsed,wall));
        for(Integer seq:expected.keySet())if(seq<sample.seq-16)expected.remove(seq);
        for(String provider:installed)manager.setTestProviderLocation(provider,location(sample,provider,elapsed,wall,session));
        if(fused!=null)Tasks.await(fused.setMockLocation(location(sample,"fused",elapsed,wall,session)),2,TimeUnit.SECONDS);
    }
    private void observe(Location location,boolean fromFused) {
        Bundle extras=location.getExtras();
        if(extras==null||!activeSession.equals(extras.getString("duomove_session","")))return;
        int seq=extras.getInt("duomove_seq",-1);
        Expected e=expected.get(seq);if(e==null)return;
        Sample s=e.sample;
        boolean same=Math.abs(location.getLatitude()-s.lat)<1e-7&&Math.abs(location.getLongitude()-s.lon)<1e-7&&
            location.hasSpeed()&&Math.abs(location.getSpeed()-s.speed)<1e-4&&location.hasBearing()&&Math.abs(location.getBearing()-s.bearing)<1e-3&&
            location.hasAccuracy()&&Math.abs(location.getAccuracy()-s.accuracy)<1e-3&&location.getElapsedRealtimeNanos()==e.elapsed&&
            location.getTime()==e.wall&&location.isFromMockProvider()&&
            (s.altitude==null?!location.hasAltitude():location.hasAltitude()&&Math.abs(location.getAltitude()-s.altitude)<1e-4);
        if(!same){mismatches.incrementAndGet();return;}
        if(fromFused)fusedObserved=Math.max(fusedObserved,seq);else frameworkObserved=Math.max(frameworkObserved,seq);
        observedElapsed=SystemClock.elapsedRealtimeNanos();
    }
    Map<String,Object> observations() {
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("delivery",delivery);result.put("observer_scope","player_app");
        result.put("framework_observed_seq",frameworkObserved);result.put("fused_observed_seq",fusedObserved);
        result.put("observer_elapsed_nanos",observedElapsed);result.put("synthetic",true);
        result.put("observer_mismatches",mismatches.get());
        return result;
    }
    @Override public void close() throws Exception {
        boolean failed=false;
        try { manager.removeUpdates(listener); }catch(Exception e){failed=true;}
        if(fused!=null) {
            try{Tasks.await(fused.removeLocationUpdates(callback),2,TimeUnit.SECONDS);}catch(Exception e){failed=true;}
            if(fusedTouched)try{Tasks.await(fused.setMockMode(false),2,TimeUnit.SECONDS);owned("fused",false);fusedTouched=false;}catch(Exception e){failed=true;}
        }
        for(Iterator<String> it=installed.iterator();it.hasNext();) {
            String provider=it.next();
            try{
                try{manager.removeTestProvider(provider);}catch(IllegalArgumentException absent){/* Already removed by Android. */}
                owned(provider,false);it.remove();
            }catch(Exception e){failed=true;}
        }
        if(!fusedTouched)fused=null;
        if(wake.isHeld())wake.release();
        if(failed)throw new IllegalStateException("provider_cleanup_failed");
    }
}
