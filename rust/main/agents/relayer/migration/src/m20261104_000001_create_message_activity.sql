-- Applied by the diagnostics migrator, never by relayer processes.
CREATE TABLE public.message_activity (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    relayer bytea NOT NULL CHECK (octet_length(relayer) = 20),
    message_id bytea NOT NULL CHECK (octet_length(message_id) = 32),
    origin bigint NOT NULL CHECK (origin BETWEEN 0 AND 4294967295),
    destination bigint NOT NULL CHECK (destination BETWEEN 0 AND 4294967295),
    observed_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    version smallint NOT NULL DEFAULT 1 CHECK (version = 1),
    activity jsonb NOT NULL CHECK (jsonb_typeof(activity) = 'object')
);
CREATE INDEX message_activity_message_id_id_idx ON public.message_activity (message_id, id DESC);
CREATE INDEX message_activity_received_at_idx ON public.message_activity USING BRIN (received_at);

CREATE FUNCTION public.notify_message_activity_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('message_activity_insert', encode(NEW.message_id, 'hex'));
    RETURN NEW;
END;
$$;

CREATE TRIGGER notify_message_activity_insert
AFTER INSERT ON public.message_activity
FOR EACH ROW
EXECUTE FUNCTION public.notify_message_activity_insert();
