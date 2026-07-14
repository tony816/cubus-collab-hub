do $migration$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_net is unavailable; skipping hosted Supabase webhook objects';
    return;
  end if;

  execute 'create extension if not exists pg_net';

  execute $sql$
    create or replace function public.notify_cubus_event_webhook()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_secret text;
    begin
      select decrypted_secret into v_secret
      from vault.decrypted_secrets
      where name = 'cubus_webhook_shared_secret'
      order by created_at desc
      limit 1;

      if v_secret is null then
        return new;
      end if;

      perform net.http_post(
        url := 'https://cubus-collab-hub.zpfhfh816.workers.dev/webhooks/supabase',
        body := jsonb_build_object(
          'type', 'INSERT',
          'table', 'events',
          'schema', 'public',
          'record', jsonb_build_object(
            'id', new.entity_id,
            'kind', new.kind,
            'entity_type', new.entity_type,
            'metadata', new.metadata
          )
        ),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-CUBUS-Webhook-Secret', v_secret
        ),
        timeout_milliseconds := 3000
      );
      return new;
    end;
    $function$
  $sql$;

  execute 'revoke execute on function public.notify_cubus_event_webhook() from public, anon, authenticated';
  execute 'drop trigger if exists cubus_event_webhook on public.events';
  execute $sql$
    create trigger cubus_event_webhook
    after insert on public.events
    for each row
    when (new.kind in ('proposal.created', 'proposal.approved', 'proposal.rejected', 'conflict.created'))
    execute function public.notify_cubus_event_webhook()
  $sql$;
end
$migration$;
