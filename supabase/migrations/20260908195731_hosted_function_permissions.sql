-- Event triggers run as their owner and do not need browser RPC permissions.
-- Some hosted projects install this helper with default PUBLIC execute access.
begin;
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
commit;
