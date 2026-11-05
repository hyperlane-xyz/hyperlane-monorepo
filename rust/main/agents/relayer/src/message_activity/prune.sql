-- Run daily with maintenance credentials; diagnostics writers have no DELETE grant.
DELETE FROM public.message_activity WHERE received_at < now() - interval '90 days';
