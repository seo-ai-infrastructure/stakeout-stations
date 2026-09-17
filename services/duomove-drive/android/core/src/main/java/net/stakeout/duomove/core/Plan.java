package net.stakeout.duomove.core;

import java.util.*;

public final class Plan {
    private final List<Sample> samples;
    public Plan(List<Sample> input) {
        if(input.size()<2 || input.size()>14401)throw new IllegalArgumentException("sample_count");
        for(int i=0;i<input.size();i++) {
            Sample s=input.get(i);
            if(s.seq!=i)throw new IllegalArgumentException("sample_order");
            if(i>0&&distance(input.get(i-1),s)>61)throw new IllegalArgumentException("position_speed_ceiling");
            if(i>0&&s.phase.equals("dwell")&&input.get(i-1).phase.equals("dwell")&&distance(input.get(i-1),s)>0.01)
                throw new IllegalArgumentException("dwell_position_changed");
        }
        if(input.get(0).speed!=0 || input.get(input.size()-1).speed!=0)throw new IllegalArgumentException("stopped_endpoints_required");
        samples=Collections.unmodifiableList(new ArrayList<>(input));
    }
    public int size(){return samples.size();}
    public Sample get(int index){return samples.get(index);}
    private static double distance(Sample a,Sample b) {
        double p=Math.toRadians(a.lat),q=Math.toRadians(b.lat),d=Math.toRadians(b.lon-a.lon);
        double h=Math.pow(Math.sin((q-p)/2),2)+Math.cos(p)*Math.cos(q)*Math.pow(Math.sin(d/2),2);
        return 12742017.6*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))));
    }
}
