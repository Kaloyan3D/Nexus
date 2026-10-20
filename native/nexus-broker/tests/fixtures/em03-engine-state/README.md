# EM-03 engine state records (compatibility fixtures, TEST ONLY)

Written by the EM-03 commit's own code (`b5a939a`, `EngineRun` in `engine_state.rs`) in a
throwaway directory, for `engine_state::em03_records_compatibility` (EM-04A).

- `engine/task_em03_muse.json`: `muse-v0`, attempt 1 answered, attempt 2 bound and never resolved
  (an interrupted run).
- `engine/task_em03_effort.json`: `effort-test-v0`, a durable `high` selection for attempt 2, bound
  and never resolved.
- `engine/task_em03_done.json`: `muse-v0`, completed (`run-ended`).
- `TEST-ONLY-throwaway-em03-hmac-key.hex`: the broker-local HMAC key of that throwaway directory.
  It authenticates these three records and nothing else, and it is not a credential. The test
  installs it as `engine-state.key` (mode 0600) in a temporary state directory.
