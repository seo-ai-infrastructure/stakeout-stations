import math

import pytest

from duomove_drive.geometry import bearing, destination, distance, make_route
from duomove_drive.planner import Stop, Trajectory, plan_hash, plan_route, validate_plan

START=(28.039465,-81.949804)


def straight(length=100):return [START,destination(START,90,length)]


def test_constant_acceleration_integrates_average_velocity():
    p=plan_route(straight(100),acceleration=2.2,cruise_mph=35,arrival_dwell=1)
    assert p['samples'][2]['distance_m']==pytest.approx(4.4,abs=1e-5)
    assert p['samples'][2]['speed_mps']==pytest.approx(4.4,abs=1e-5)


def test_short_geometry_segments_do_not_discard_distance():
    route=[destination(START,90,i) for i in range(0,501,5)]
    p=plan_route(route,cruise_mph=35,acceleration=2.2,arrival_dwell=1)
    at=p['samples'][15]
    assert at['distance_m']>150
    assert at['speed_mps']==pytest.approx(35*0.44704)
    assert p['samples'][16]['distance_m']-at['distance_m']==pytest.approx(at['speed_mps'],abs=1e-6)


def test_braking_moves_until_stop_then_stationary_fixes_continue():
    p=plan_route(straight(300),stops=[Stop(150,8)],arrival_dwell=5)
    samples=p['samples']
    red=[s for s in samples if s['phase']=='dwell' and abs(s['distance_m']-150)<1e-6]
    assert len(red)>=8
    assert all(s['speed_mps']==0 for s in red)
    decelerating=[(a,b) for a,b in zip(samples,samples[1:]) if 0<b['speed_mps']<a['speed_mps']]
    assert decelerating and all(b['distance_m']>a['distance_m'] for a,b in decelerating)
    arrived=[s for s in samples if s['distance_m']==pytest.approx(p['total_distance_m'],abs=1e-7)]
    assert len(arrived)>=5
    assert len({s['t_ms'] for s in arrived})==len(arrived)


def test_acceleration_and_braking_bounds_survive_corner_and_stop():
    end=destination(START,90,150)
    p=plan_route([START,end,destination(end,0,150)],stops=[Stop(200,3)])
    for a,b in zip(p['samples'],p['samples'][1:]):
        assert -2.000001<=b['speed_mps']-a['speed_mps']<=1.500001
        assert b['distance_m']>=a['distance_m']
    validate_plan(p)


def test_corner_is_rounded_with_slow_speed_and_preserved_endpoints():
    corner=destination(START,90,100)
    end=destination(corner,0,100)
    route=make_route([START,corner,end],15,corner_cut_m=2)
    assert route.nodes[0].coordinate==START
    assert distance(route.nodes[-1].coordinate,end)<1e-6
    curved=[n for n in route.nodes if n.speed_cap<15]
    assert len(curved)>3 and min(n.speed_cap for n in curved)<5
    # The rounded corner stays within the configured envelope of either street.
    for n in curved:
        east=distance((corner[0],n.coordinate[1]),corner)
        north=distance((n.coordinate[0],corner[1]),corner)
        assert min(east,north)<2.05


def test_short_routes_duplicate_vertices_and_u_turns():
    for route in ([START,START,destination(START,90,0.5)],
                  [START,destination(START,90,5),START,destination(START,90,5)]):
        plan=plan_route(route,arrival_dwell=1)
        validate_plan(plan)
        assert plan['samples'][-1]['speed_mps']==0


def test_antimeridian_uses_short_path():
    a=(10,179.999);b=(10,-179.999)
    p=plan_route([a,b],arrival_dwell=1)
    assert 200<p['total_distance_m']<230
    assert all(abs(s['lon'])>179.99 for s in p['samples'])


def test_identical_inputs_have_identical_plan_hash():
    assert plan_hash(plan_route(straight()))==plan_hash(plan_route(straight()))


@pytest.mark.parametrize('coords,opts',[
    ([START,START],{}),(straight(),{'cruise_mph':0}),
    ([(math.nan,0),(0,1)],{}),(straight(),{'acceleration':float('inf')}),
    (straight(),{'stops':[Stop(1000)]}),(straight(),{'stops':[Stop(20),Stop(20)]}),
    (straight(),{'arrival_dwell':-1}),
])
def test_invalid_plans_rejected(coords,opts):
    with pytest.raises(ValueError):plan_route(coords,**opts)


def test_every_analytic_leg_conserves_distance_and_stop_speed():
    route=make_route(straight(1000),15)
    trajectory=Trajectory(route,1.5,2,[Stop(450,10)],30)
    for leg in trajectory.legs:
        duration=leg.end_t-leg.start_t
        assert (leg.start_v+leg.end_v)*duration/2==pytest.approx(leg.end_s-leg.start_s,abs=1e-8)
        s,v=leg.at(leg.end_t)
        assert s==pytest.approx(leg.end_s,abs=1e-8)
        assert v==pytest.approx(leg.end_v,abs=1e-8)
