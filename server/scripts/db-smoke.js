require('dotenv').config();
const pool=require('../src/db');
(async()=>{
  try{
    const health=await pool.query('SELECT NOW() current_time, current_database() database_name');
    const required=['users','appointments','appointment_workflows','medical_intakes','legal_matters','technology_engagements','payments','invoices','refunds','provider_earnings_ledger','secure_documents','consent_records','privacy_requests','organizations','admin_role_assignments','audit_events','consultation_cases','case_handover_requests','case_provider_access','consultation_recordings','consultation_recording_consents','consultation_transcripts'];
    const tables=await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])`,[required]);
    const found=new Set(tables.rows.map(x=>x.tablename));const missing=required.filter(x=>!found.has(x));
    if(missing.length)throw new Error(`Missing tables: ${missing.join(', ')}. Run npm run db:migrate.`);
    console.log(`Database connected: ${health.rows[0].database_name} @ ${health.rows[0].current_time.toISOString()}`);
    console.log(`Smoke check passed: ${required.length} critical tables found.`);
  }catch(e){console.error('Database smoke check failed:',e.message);process.exitCode=1;}finally{await pool.end();}
})();
