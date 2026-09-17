package net.stakeout.duomove.core;

/** One immutable synthetic observation at a specified simulation time. */
public final class Sample {
    public final int seq;
    public final long timeMs;
    public final double lat, lon, speed, bearing, accuracy;
    public final Double altitude;
    public final String phase;
    public Sample(int seq,long timeMs,double lat,double lon,double speed,double bearing,double accuracy,Double altitude,String phase) {
        this.seq=seq;this.timeMs=timeMs;this.lat=lat;this.lon=lon;this.speed=speed;
        this.bearing=bearing;this.accuracy=accuracy;this.altitude=altitude;this.phase=phase;
        range(lat,-85,85);range(lon,-180,180);range(speed,0,60);range(bearing,0,359.999999999);range(accuracy,0.1,1000);
        if(altitude!=null)range(altitude,-12000,100000);
        if(seq<0 || timeMs!=seq*1000L || !("drive".equals(phase)||"dwell".equals(phase)))throw new IllegalArgumentException("invalid_sample");
        if("dwell".equals(phase)&&speed!=0)throw new IllegalArgumentException("moving_dwell");
    }
    private static void range(double value,double low,double high) {
        if(!Double.isFinite(value)||value<low||value>high)throw new IllegalArgumentException("sample_range");
    }
}
