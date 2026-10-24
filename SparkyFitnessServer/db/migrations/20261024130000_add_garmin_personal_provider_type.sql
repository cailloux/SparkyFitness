-- SparkyFitnessServer/db/migrations/20261024130000_add_garmin_personal_provider_type.sql
-- Add the Garmin Connect Personal API provider type: Garmin's official,
-- read-only API, keyed by a personal API key (like Hevy and Liftosaur). The key
-- is stored encrypted in external_data_providers.app_key and never shared
-- (is_strictly_private = TRUE, like the other wearable integrations).

INSERT INTO public.external_provider_types (id, display_name, description)
VALUES ('garmin_personal', 'Garmin Connect (Personal API)', 'Garmin health, sleep, activities and nutrition via the official Garmin Connect Personal API key')
ON CONFLICT (id) DO NOTHING;

UPDATE public.external_provider_types
SET categories = ARRAY['other'],
    required_fields = ARRAY['app_key'],
    field_labels = '{"app_key": "Personal API Key"}'::jsonb,
    is_strictly_private = TRUE
WHERE id = 'garmin_personal';
