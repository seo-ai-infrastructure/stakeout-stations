package net.stakeout.duomove.core;

import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;
import net.stakeout.duomove.core.*;

public final class PlanJson {
    public static JSONObject object(String text) throws JSONException {
        JSONTokener tokens=new JSONTokener(text);
        Object value=tokens.nextValue();
        if(!(value instanceof JSONObject)||tokens.nextClean()!=0)throw new JSONException("invalid_json");
        return (JSONObject)value;
    }
    public static double number(JSONObject object,String name) throws JSONException {
        Object value=object.get(name);
        if(!(value instanceof Number)||!Double.isFinite(((Number)value).doubleValue()))throw new JSONException("numeric_required");
        return ((Number)value).doubleValue();
    }
    public static long integer(JSONObject object,String name,long min,long max) throws JSONException {
        double value=number(object,name);
        if(value<min||value>max||value!=Math.rint(value))throw new JSONException("integer_range");
        return (long)value;
    }
    public static Plan decode(byte[] bytes) throws Exception {
        JSONObject root=object(new String(bytes,StandardCharsets.UTF_8));
        integer(root,"version",1,1);integer(root,"interval_ms",1000,1000);
        JSONArray data=root.getJSONArray("samples");
        if(data.length()<2||data.length()>14401)throw new JSONException("sample_count");
        integer(root,"duration_ms",(data.length()-1)*1000L,(data.length()-1)*1000L);
        List<Sample> samples=new ArrayList<>();
        for(int i=0;i<data.length();i++) {
            JSONObject item=data.getJSONObject(i);
            samples.add(new Sample((int)integer(item,"seq",i,i),integer(item,"t_ms",i*1000L,i*1000L),
                number(item,"lat"),number(item,"lon"),number(item,"speed_mps"),number(item,"bearing_deg"),
                number(item,"accuracy_m"),item.isNull("altitude_m")?null:number(item,"altitude_m"),item.getString("phase")));
        }
        return new Plan(samples);
    }
}
