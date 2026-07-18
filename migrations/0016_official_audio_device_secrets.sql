ALTER TABLE official_audio_devices ADD COLUMN device_secret_hash TEXT;
ALTER TABLE official_audio_device_events ADD COLUMN device_secret_hash TEXT;

UPDATE official_audio_devices
SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE released_at IS NULL;
