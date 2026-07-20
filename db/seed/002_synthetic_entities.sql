-- SYNTHETIC DATA ONLY. All names, organizations, accounts, and addresses below are fictional
-- and constructed for development/testing. No real individuals or institutions are represented.
-- Real customer data is a deliberate, later, DPA-gated decision — see the strategy document.

-- Local dev users spanning every role/clearance combination, used by both the app and by
-- db/scripts/test-rls.sh to prove RLS with real, differently-privileged sessions.
INSERT INTO app_users (id, email, display_name, role, clearance) VALUES
  ('11111111-1111-1111-1111-111111111101', 'alice.analyst@example-bank.test', 'Alice Analyst', 'analyst', 'INTERNAL'),
  ('11111111-1111-1111-1111-111111111102', 'sam.supervisor@example-bank.test', 'Sam Supervisor', 'supervisor', 'SENSITIVE'),
  ('11111111-1111-1111-1111-111111111103', 'cara.compliance@example-bank.test', 'Cara Compliance', 'compliance', 'RESTRICTED'),
  ('11111111-1111-1111-1111-111111111104', 'adam.admin@example-bank.test', 'Adam Admin', 'admin', 'RESTRICTED')
ON CONFLICT (id) DO NOTHING;

-- Persons
INSERT INTO objects (id, object_type_id, properties, classification) VALUES
  ('a0000000-0000-4000-8000-000000000001', (SELECT id FROM object_types WHERE name='Person'),
    '{"name":"Jordan Vance","dob":"1984-03-11","nationality":"BE","id_number":"BE-FAKE-00019284"}', 'INTERNAL'),
  ('a0000000-0000-4000-8000-000000000002', (SELECT id FROM object_types WHERE name='Person'),
    '{"name":"Priya Okonkwo-Lindqvist","dob":"1990-11-02","nationality":"NL","id_number":"NL-FAKE-00284471"}', 'INTERNAL'),
  ('a0000000-0000-4000-8000-000000000003', (SELECT id FROM object_types WHERE name='Person'),
    '{"name":"Marek Dubois","dob":"1978-06-23","nationality":"FR","id_number":"FR-FAKE-00110293"}', 'SENSITIVE'),
  ('a0000000-0000-4000-8000-000000000004', (SELECT id FROM object_types WHERE name='Person'),
    '{"name":"Elena Castellanos","dob":"1986-09-17","nationality":"ES","id_number":"ES-FAKE-00937712"}', 'RESTRICTED')
ON CONFLICT (id) DO NOTHING;

-- Organizations
INSERT INTO objects (id, object_type_id, properties, classification) VALUES
  ('a0000000-0000-4000-8000-000000000011', (SELECT id FROM object_types WHERE name='Organization'),
    '{"name":"Northwind Fiduciary SA","registration_number":"BE-FAKE-0765.432.109","jurisdiction":"BE","industry":"Corporate services"}', 'SENSITIVE'),
  ('a0000000-0000-4000-8000-000000000012', (SELECT id FROM object_types WHERE name='Organization'),
    '{"name":"Blue Harbor Trading Ltd","registration_number":"UK-FAKE-09876543","jurisdiction":"UK","industry":"Import/export"}', 'INTERNAL'),
  ('a0000000-0000-4000-8000-000000000013', (SELECT id FROM object_types WHERE name='Organization'),
    '{"name":"Solstice Import-Export BV","registration_number":"NL-FAKE-77.654.321","jurisdiction":"NL","industry":"Trading"}', 'SENSITIVE')
ON CONFLICT (id) DO NOTHING;

-- Accounts
INSERT INTO objects (id, object_type_id, properties, classification) VALUES
  ('a0000000-0000-4000-8000-000000000021', (SELECT id FROM object_types WHERE name='Account'),
    '{"account_number":"...4821","iban":"BE00FAKE00000004821","currency":"EUR","bank_name":"Meridian Bank NV","status":"active"}', 'SENSITIVE'),
  ('a0000000-0000-4000-8000-000000000022', (SELECT id FROM object_types WHERE name='Account'),
    '{"account_number":"...7734","iban":"NL00FAKE00000007734","currency":"EUR","bank_name":"Meridian Bank NV","status":"active"}', 'INTERNAL'),
  ('a0000000-0000-4000-8000-000000000023', (SELECT id FROM object_types WHERE name='Account'),
    '{"account_number":"...1190","iban":"GB00FAKE00000001190","currency":"GBP","bank_name":"Meridian Bank NV","status":"active"}', 'INTERNAL'),
  ('a0000000-0000-4000-8000-000000000024', (SELECT id FROM object_types WHERE name='Account'),
    '{"account_number":"...5502","iban":"NL00FAKE00000005502","currency":"EUR","bank_name":"Meridian Bank NV","status":"active"}', 'SENSITIVE')
ON CONFLICT (id) DO NOTHING;

-- Locations
INSERT INTO objects (id, object_type_id, properties, classification) VALUES
  ('a0000000-0000-4000-8000-000000000031', (SELECT id FROM object_types WHERE name='Location'),
    '{"address_line":"12 Rue Fictive","city":"Brussels","country":"BE","postal_code":"1000"}', 'PUBLIC'),
  ('a0000000-0000-4000-8000-000000000032', (SELECT id FROM object_types WHERE name='Location'),
    '{"address_line":"88 Vaartweg","city":"Amsterdam","country":"NL","postal_code":"1011AB"}', 'RESTRICTED')
ON CONFLICT (id) DO NOTHING;

-- Device
INSERT INTO objects (id, object_type_id, properties, classification) VALUES
  ('a0000000-0000-4000-8000-000000000041', (SELECT id FROM object_types WHERE name='Device'),
    '{"device_id":"FAKE-DEVICE-9F3B2A","device_type":"mobile"}', 'SENSITIVE')
ON CONFLICT (id) DO NOTHING;

-- Alert
INSERT INTO objects (id, object_type_id, properties, classification) VALUES
  ('a0000000-0000-4000-8000-000000000051', (SELECT id FROM object_types WHERE name='Alert'),
    '{"alert_type":"structuring","rule_name":"SR-014 Structuring beneath reporting threshold","triggered_at":"2026-07-12T08:41:00Z","status":"open"}', 'SENSITIVE')
ON CONFLICT (id) DO NOTHING;

-- Document (illustrates a RESTRICTED-classified attachment)
INSERT INTO objects (id, object_type_id, properties, classification) VALUES
  ('a0000000-0000-4000-8000-000000000061', (SELECT id FROM object_types WHERE name='Document'),
    '{"title":"Draft SAR narrative - Account 4821","doc_type":"sar_draft"}', 'RESTRICTED')
ON CONFLICT (id) DO NOTHING;

-- Provenance examples
INSERT INTO object_property_meta (object_id, property_key, source, confidence, classification, raw_source_ref) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'name', 'core_banking_export_2026_07', 0.980, 'INTERNAL', 'CBS-EXPORT-2026-07-14#row488'),
  ('a0000000-0000-4000-8000-000000000004', 'name', 'sanctions_screening_vendor_x', 0.810, 'RESTRICTED', 'SSX-BATCH-2026-07-10#hit112'),
  ('a0000000-0000-4000-8000-000000000051', 'alert_type', 'transaction_monitoring_system', 0.950, 'SENSITIVE', 'TMS-RULE-SR014#2026-07-12');

-- Edges
INSERT INTO edges (source_object_id, target_object_id, relationship_type_id, properties, classification, source) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000011',
    (SELECT id FROM relationship_types WHERE name='employed_by'), '{"title":"Director"}', 'SENSITIVE', 'corporate_registry_export'),
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000021',
    (SELECT id FROM relationship_types WHERE name='owns_account'), '{}', 'INTERNAL', 'core_banking_export_2026_07'),
  ('a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000022',
    (SELECT id FROM relationship_types WHERE name='owns_account'), '{}', 'INTERNAL', 'core_banking_export_2026_07'),
  ('a0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000023',
    (SELECT id FROM relationship_types WHERE name='owns_account'), '{}', 'INTERNAL', 'core_banking_export_2026_07'),
  ('a0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000024',
    (SELECT id FROM relationship_types WHERE name='owns_account'), '{}', 'SENSITIVE', 'core_banking_export_2026_07'),
  ('a0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000023',
    (SELECT id FROM relationship_types WHERE name='transacted_with'), '{"amount":9800,"currency":"EUR","date":"2026-07-08","channel":"wire"}', 'SENSITIVE', 'transaction_monitoring_system'),
  ('a0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000024',
    (SELECT id FROM relationship_types WHERE name='transacted_with'), '{"amount":9700,"currency":"EUR","date":"2026-07-09","channel":"wire"}', 'SENSITIVE', 'transaction_monitoring_system'),
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000041',
    (SELECT id FROM relationship_types WHERE name='shared_device'), '{}', 'SENSITIVE', 'device_fingerprint_vendor'),
  ('a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000041',
    (SELECT id FROM relationship_types WHERE name='shared_device'), '{}', 'SENSITIVE', 'device_fingerprint_vendor'),
  ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000032',
    (SELECT id FROM relationship_types WHERE name='located_at'), '{}', 'RESTRICTED', 'sanctions_screening_vendor_x'),
  ('a0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000051',
    (SELECT id FROM relationship_types WHERE name='flagged_by'), '{}', 'SENSITIVE', 'transaction_monitoring_system');
