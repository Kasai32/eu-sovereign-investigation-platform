-- Object/relationship type definitions for the AML/financial-crime wedge (Section 1 of the
-- blueprint: alert-to-case investigation). Defined as data, not code, per the ontology design.

INSERT INTO object_types (name, property_schema) VALUES
  ('Person', '{"type":"object","required":["name"],"properties":{
     "name":{"type":"string"},"dob":{"type":"string","format":"date"},
     "nationality":{"type":"string"},"id_number":{"type":"string"}}}'),
  ('Organization', '{"type":"object","required":["name"],"properties":{
     "name":{"type":"string"},"registration_number":{"type":"string"},
     "jurisdiction":{"type":"string"},"industry":{"type":"string"}}}'),
  ('Account', '{"type":"object","required":["account_number"],"properties":{
     "account_number":{"type":"string"},"iban":{"type":"string"},
     "currency":{"type":"string"},"opened_date":{"type":"string","format":"date"},
     "status":{"type":"string"},"bank_name":{"type":"string"}}}'),
  ('Location', '{"type":"object","required":["address_line"],"properties":{
     "address_line":{"type":"string"},"city":{"type":"string"},
     "country":{"type":"string"},"postal_code":{"type":"string"}}}'),
  ('Device', '{"type":"object","required":["device_id"],"properties":{
     "device_id":{"type":"string"},"device_type":{"type":"string"}}}'),
  ('Alert', '{"type":"object","required":["alert_type"],"properties":{
     "alert_type":{"type":"string"},"rule_name":{"type":"string"},
     "triggered_at":{"type":"string","format":"date-time"},"status":{"type":"string"}}}'),
  ('Document', '{"type":"object","required":["title"],"properties":{
     "title":{"type":"string"},"doc_type":{"type":"string"}}}')
ON CONFLICT (name) DO NOTHING;

INSERT INTO relationship_types (name, from_object_type_id, to_object_type_id) VALUES
  ('employed_by', (SELECT id FROM object_types WHERE name='Person'), (SELECT id FROM object_types WHERE name='Organization')),
  ('owns_account', NULL, (SELECT id FROM object_types WHERE name='Account')),  -- Person or Organization can own an account
  ('located_at', NULL, (SELECT id FROM object_types WHERE name='Location')),
  ('transacted_with', (SELECT id FROM object_types WHERE name='Account'), (SELECT id FROM object_types WHERE name='Account')),
  ('shared_device', (SELECT id FROM object_types WHERE name='Person'), (SELECT id FROM object_types WHERE name='Device')),
  ('flagged_by', (SELECT id FROM object_types WHERE name='Account'), (SELECT id FROM object_types WHERE name='Alert')),
  ('evidenced_by', NULL, (SELECT id FROM object_types WHERE name='Document'))
ON CONFLICT (name) DO NOTHING;
