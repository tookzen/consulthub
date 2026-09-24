require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

const DEMO_PASSWORD = 'Password123!';

async function upsertUser(client, data) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const result = await client.query(
    `INSERT INTO users(first_name, last_name, email, phone, password_hash, role, email_verified, email_verified_at)
     VALUES ($1,$2,LOWER($3),$4,$5,$6,TRUE,NOW())
     ON CONFLICT(email) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
       phone = EXCLUDED.phone, password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, is_active = TRUE, email_verified=TRUE, email_verified_at=COALESCE(users.email_verified_at,NOW())
     RETURNING *`,
    [data.firstName, data.lastName, data.email, data.phone || null, hash, data.role]
  );
  return result.rows[0];
}

async function addVerifiedEvidence(client, providerId, firstName, lastName, regulatoryBody, registrationNumber, qualification) {
  const identityExists = await client.query(`SELECT 1 FROM identity_verifications WHERE provider_id=$1 AND status='VERIFIED'`, [providerId]);
  if (!identityExists.rowCount) {
    await client.query(
      `INSERT INTO identity_verifications(provider_id,legal_first_name,legal_last_name,id_type,id_number_last4,document_reference,selfie_reference,
       provider_name,provider_reference,document_authentic,liveness_passed,face_match_passed,confidence,status,checked_at,raw_result)
       VALUES ($1,$2,$3,'SA_ID','0000','seed://id-document','seed://selfie','MOCK_IDENTITY_PROVIDER','SEED-IDV',TRUE,TRUE,TRUE,0.99,'VERIFIED',NOW(),'{}')`,
      [providerId, firstName, lastName]
    );
  }
  const regExists = await client.query(`SELECT 1 FROM professional_registrations WHERE provider_id=$1 AND status='VERIFIED'`, [providerId]);
  if (!regExists.rowCount) {
    await client.query(
      `INSERT INTO professional_registrations(provider_id,regulatory_body,registration_number,registration_category,registration_status,name_match,source,status,verified_at,next_verification_at,raw_result)
       VALUES ($1,$2,$3,'Independent Practice','ACTIVE',TRUE,$4,'VERIFIED',NOW(),NOW()+INTERVAL '30 days','{}')`,
      [providerId, regulatoryBody, registrationNumber, `MOCK_${regulatoryBody}_REGISTRY`]
    );
  }
  const qualExists = await client.query(`SELECT 1 FROM professional_qualifications WHERE provider_id=$1 AND status='VERIFIED'`, [providerId]);
  if (!qualExists.rowCount) {
    await client.query(
      `INSERT INTO professional_qualifications(provider_id,institution,qualification_name,year_awarded,country,document_reference,verification_source,verification_reference,status,verified_at)
       VALUES ($1,$2,$3,2014,'South Africa','seed://qualification','MOCK_SAQA_NLRD','SEED-QUAL','VERIFIED',NOW())`,
      [providerId, qualification.institution, qualification.name]
    );
  }
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const categories = [
      ['Medical', 'medical', 'Online consultations with healthcare professionals.'],
      ['Legal', 'legal', 'Consultations with lawyers and legal professionals.'],
      ['Accounting & Tax', 'accounting-tax', 'Accounting, bookkeeping and tax advisory services.'],
      ['Technology', 'technology', 'Software, IT and technical consulting.'],
      ['Education', 'education', 'Tutoring, coaching and education services.']
    ];

    const categoryIds = {};
    for (const [name, slug, description] of categories) {
      const r = await client.query(
        `INSERT INTO service_categories(name, slug, description)
         VALUES ($1,$2,$3)
         ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description
         RETURNING id`, [name, slug, description]
      );
      categoryIds[slug] = r.rows[0].id;
    }

    const clientSeedUser = await upsertUser(client, { firstName: 'Naledi', lastName: 'Mokoena', email: 'client@consulthub.local', role: 'CLIENT', phone: '+27 71 000 0001' });
    const adminUser = await upsertUser(client, { firstName: 'System', lastName: 'Administrator', email: 'admin@consulthub.local', role: 'ADMIN', phone: '+27 71 000 0099' });
    await client.query(`INSERT INTO admin_role_assignments(user_id,admin_role,granted_by) VALUES($1,'SUPER_ADMIN',$1) ON CONFLICT(user_id,admin_role) DO NOTHING`,[adminUser.id]);

    const workflowRows=[['medical','MEDICAL','Medical telehealth workflow'],['legal','LEGAL','Legal consultation workflow'],['technology','TECHNOLOGY','Technology consulting workflow'],['accounting-tax','GENERAL','Professional services workflow'],['education','GENERAL','Professional services workflow']];
    for(const [slug,key,name] of workflowRows) if(categoryIds[slug]) await client.query(`INSERT INTO service_category_workflows(category_id,workflow_key,display_name,preconsultation_requirements,room_policy,retention_policy) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) ON CONFLICT(category_id) DO UPDATE SET workflow_key=EXCLUDED.workflow_key,display_name=EXCLUDED.display_name,preconsultation_requirements=EXCLUDED.preconsultation_requirements,room_policy=EXCLUDED.room_policy,retention_policy=EXCLUDED.retention_policy,updated_at=NOW()`,[categoryIds[slug],key,name,JSON.stringify(key==='MEDICAL'?{intake:true,telehealthConsent:true,emergencyContext:true}:key==='LEGAL'?{matterIntake:true,parties:true,conflictScreening:true}:key==='TECHNOLOGY'?{requirements:true,acceptanceCriteria:true}:{}),JSON.stringify({requiresConfirmedPayment:true,requiresWorkflowClearance:key!=='GENERAL'}),JSON.stringify({policy:'CONFIGURE_BEFORE_PRODUCTION'})]);
    await client.query(`INSERT INTO platform_fee_rules(name,percentage,fixed_amount,currency,is_active) VALUES('Default demo platform fee',10,0,'ZAR',TRUE) ON CONFLICT(name) DO UPDATE SET percentage=10,is_active=TRUE`);

    const doctorUser = await upsertUser(client, { firstName: 'Ayanda', lastName: 'Nkosi', email: 'doctor@consulthub.local', role: 'PROVIDER', phone: '+27 71 000 0002' });
    const doctorProfile = await client.query(
      `INSERT INTO provider_profiles(user_id, category_id, profession, registration_number, biography, years_experience, city, verification_status,verification_submitted_at,verified_at)
       VALUES ($1,$2,'General Practitioner','DEMO-HPCSA-001','General practitioner offering convenient online consultations for non-emergency concerns and follow-up discussions.',11,'Johannesburg','VERIFIED',NOW(),NOW())
       ON CONFLICT(user_id) DO UPDATE SET category_id=EXCLUDED.category_id, profession=EXCLUDED.profession,
         registration_number=EXCLUDED.registration_number, biography=EXCLUDED.biography, years_experience=EXCLUDED.years_experience, city=EXCLUDED.city,
         verification_status='VERIFIED', verification_submitted_at=COALESCE(provider_profiles.verification_submitted_at,NOW()), verified_at=COALESCE(provider_profiles.verified_at,NOW())
       RETURNING id`, [doctorUser.id, categoryIds.medical]
    );
    await addVerifiedEvidence(client, doctorProfile.rows[0].id, 'Ayanda', 'Nkosi', 'HPCSA', 'DEMO-HPCSA-001', { institution: 'University of Demo Health Sciences', name: 'MBChB' });
    await client.query(`INSERT INTO medical_provider_profiles(provider_id,speciality,practice_name,hpcsa_practice_category,emergency_support_ack) VALUES($1,'General Practice','Nkosi Virtual Practice','Independent Practice',TRUE) ON CONFLICT(provider_id) DO UPDATE SET speciality=EXCLUDED.speciality,practice_name=EXCLUDED.practice_name,hpcsa_practice_category=EXCLUDED.hpcsa_practice_category,emergency_support_ack=TRUE`,[doctorProfile.rows[0].id]);

    // A second verified doctor is seeded so client-approved case handover can be tested locally.
    const doctor2User = await upsertUser(client, { firstName: 'Nandi', lastName: 'Khumalo', email: 'doctor2@consulthub.local', role: 'PROVIDER', phone: '+27 71 000 0006' });
    const doctor2Profile = await client.query(
      `INSERT INTO provider_profiles(user_id, category_id, profession, registration_number, biography, years_experience, city, verification_status,verification_submitted_at,verified_at)
       VALUES ($1,$2,'General Practitioner','DEMO-HPCSA-002','General practitioner available for continuity-of-care handovers and online follow-up consultations.',8,'Johannesburg','VERIFIED',NOW(),NOW())
       ON CONFLICT(user_id) DO UPDATE SET category_id=EXCLUDED.category_id, profession=EXCLUDED.profession,
         registration_number=EXCLUDED.registration_number, biography=EXCLUDED.biography, years_experience=EXCLUDED.years_experience, city=EXCLUDED.city,
         verification_status='VERIFIED', verification_submitted_at=COALESCE(provider_profiles.verification_submitted_at,NOW()), verified_at=COALESCE(provider_profiles.verified_at,NOW())
       RETURNING id`, [doctor2User.id, categoryIds.medical]
    );
    await addVerifiedEvidence(client, doctor2Profile.rows[0].id, 'Nandi', 'Khumalo', 'HPCSA', 'DEMO-HPCSA-002', { institution: 'University of Demo Health Sciences', name: 'MBChB' });
    await client.query(`INSERT INTO medical_provider_profiles(provider_id,speciality,practice_name,hpcsa_practice_category,emergency_support_ack) VALUES($1,'General Practice','Khumalo Virtual Practice','Independent Practice',TRUE) ON CONFLICT(provider_id) DO UPDATE SET speciality=EXCLUDED.speciality,practice_name=EXCLUDED.practice_name,hpcsa_practice_category=EXCLUDED.hpcsa_practice_category,emergency_support_ack=TRUE`,[doctor2Profile.rows[0].id]);

    const lawyerUser = await upsertUser(client, { firstName: 'Karabo', lastName: 'Dlamini', email: 'lawyer@consulthub.local', role: 'PROVIDER', phone: '+27 71 000 0003' });
    const lawyerProfile = await client.query(
      `INSERT INTO provider_profiles(user_id, category_id, profession, registration_number, biography, years_experience, city, verification_status,verification_submitted_at,verified_at)
       VALUES ($1,$2,'Attorney','DEMO-LPC-001','Attorney providing initial consultations on contracts, commercial matters and general legal questions.',9,'Pretoria','VERIFIED',NOW(),NOW())
       ON CONFLICT(user_id) DO UPDATE SET category_id=EXCLUDED.category_id, profession=EXCLUDED.profession,
         registration_number=EXCLUDED.registration_number, biography=EXCLUDED.biography, years_experience=EXCLUDED.years_experience, city=EXCLUDED.city,
         verification_status='VERIFIED', verification_submitted_at=COALESCE(provider_profiles.verification_submitted_at,NOW()), verified_at=COALESCE(provider_profiles.verified_at,NOW())
       RETURNING id`, [lawyerUser.id, categoryIds.legal]
    );
    await addVerifiedEvidence(client, lawyerProfile.rows[0].id, 'Karabo', 'Dlamini', 'LPC', 'DEMO-LPC-001', { institution: 'University of Demo Law', name: 'LLB' });
    await client.query(`INSERT INTO legal_provider_profiles(provider_id,firm_name,practitioner_type,areas_of_practice,trust_account_applicable) VALUES($1,'Dlamini Attorneys','Attorney',ARRAY['Commercial Law','Contracts'],TRUE) ON CONFLICT(provider_id) DO UPDATE SET firm_name=EXCLUDED.firm_name,practitioner_type=EXCLUDED.practitioner_type,areas_of_practice=EXCLUDED.areas_of_practice,trust_account_applicable=TRUE`,[lawyerProfile.rows[0].id]);


    const techUser = await upsertUser(client, { firstName: 'Lerato', lastName: 'Maseko', email: 'it@consulthub.local', role: 'PROVIDER', phone: '+27 71 000 0005' });
    const techProfile = await client.query(
      `INSERT INTO provider_profiles(user_id,category_id,profession,registration_number,biography,years_experience,city,verification_status,verification_submitted_at,verified_at)
       VALUES ($1,$2,'IT Consultant',NULL,'Software architecture, integration and cloud consulting.',12,'Johannesburg','VERIFIED',NOW(),NOW())
       ON CONFLICT(user_id) DO UPDATE SET category_id=EXCLUDED.category_id,profession=EXCLUDED.profession,biography=EXCLUDED.biography,years_experience=EXCLUDED.years_experience,city=EXCLUDED.city,verification_status='VERIFIED',verified_at=COALESCE(provider_profiles.verified_at,NOW()) RETURNING id`,
      [techUser.id,categoryIds.technology]
    );
    await addVerifiedEvidence(client, techProfile.rows[0].id, 'Lerato', 'Maseko', 'GENERIC', 'TECH-DEMO-001', { institution: 'Demo Institute of Technology', name: 'BSc Information Technology' });
    await client.query(`INSERT INTO technology_provider_profiles(provider_id,specialities,delivery_modes,service_regions) VALUES($1,ARRAY['Software Architecture','SAP Integration','Cloud'],ARRAY['Online'],ARRAY['South Africa']) ON CONFLICT(provider_id) DO UPDATE SET specialities=EXCLUDED.specialities,delivery_modes=EXCLUDED.delivery_modes,service_regions=EXCLUDED.service_regions`,[techProfile.rows[0].id]);

    const pendingUser = await upsertUser(client, { firstName: 'Pending', lastName: 'Doctor', email: 'pending@consulthub.local', role: 'PROVIDER', phone: '+27 71 000 0004' });
    const pendingProfile = await client.query(
      `INSERT INTO provider_profiles(user_id,category_id,profession,registration_number,biography,years_experience,city,verification_status,verification_submitted_at)
       VALUES ($1,$2,'Medical Practitioner','HPCSA-DEMO-PENDING','Demo provider awaiting final admin approval.',4,'Cape Town','PENDING',NOW())
       ON CONFLICT(user_id) DO UPDATE SET category_id=EXCLUDED.category_id, profession=EXCLUDED.profession, registration_number=EXCLUDED.registration_number,
         biography=EXCLUDED.biography, city=EXCLUDED.city, verification_status='PENDING', verification_submitted_at=NOW()
       RETURNING id`, [pendingUser.id, categoryIds.medical]
    );
    await addVerifiedEvidence(client, pendingProfile.rows[0].id, 'Pending', 'Doctor', 'HPCSA', 'HPCSA-DEMO-PENDING', { institution: 'Demo Medical University', name: 'MBChB' });

    const providers = [
      { id: doctorProfile.rows[0].id, services: [['General Online Consultation','Discuss non-emergency symptoms or general health concerns.',30,650],['Follow-up Consultation','Follow-up after a previous consultation.',20,450]] },
      { id: doctor2Profile.rows[0].id, services: [['General Online Consultation','General online consultation and continuity-of-care follow-up.',30,620],['Case Handover Follow-up','Follow-up consultation after a client-approved case transfer.',30,500]] },
      { id: lawyerProfile.rows[0].id, services: [['Initial Legal Consultation','Discuss your matter and possible next steps.',45,900],['Contract Review Discussion','Consultation regarding a contract or agreement.',60,1400]] },
      { id: techProfile.rows[0].id, services: [['IT Architecture Consultation','Discuss systems, integrations, architecture and delivery options.',60,1200],['Technical Troubleshooting Session','Structured diagnosis of a technical problem.',45,850]] },
      { id: pendingProfile.rows[0].id, services: [['General Online Consultation','Demo service that becomes bookable after approval.',30,550]] }
    ];

    for (const provider of providers) {
      await client.query(`UPDATE provider_profiles SET accepting_service_requests=TRUE WHERE id=$1`, [provider.id]);
      for (const [name, description, duration, price] of provider.services) {
        const exists = await client.query('SELECT id FROM provider_services WHERE provider_id=$1 AND name=$2', [provider.id, name]);
        if (!exists.rowCount) {
          await client.query(`INSERT INTO provider_services(provider_id,name,description,duration_minutes,price,currency) VALUES ($1,$2,$3,$4,$5,'ZAR')`, [provider.id, name, description, duration, price]);
        }
      }
      for (const day of [1,2,3,4,5]) {
        await client.query(
          `INSERT INTO provider_availability(provider_id,day_of_week,start_time,end_time)
           VALUES ($1,$2,'09:00','16:00') ON CONFLICT(provider_id,day_of_week,start_time,end_time) DO NOTHING`, [provider.id, day]
        );
      }
    }



    for (const provider of providers) {
      await client.query(`INSERT INTO provider_calendar_settings(provider_id) VALUES($1) ON CONFLICT(provider_id) DO NOTHING`, [provider.id]);
    }

    // A paid appointment roughly 10 minutes from seed time lets you test the built-in WebRTC room immediately.
    const clientUser = await client.query(`SELECT id FROM users WHERE email='client@consulthub.local'`);

    // Reset one open marketplace request so the lawyer account can immediately test the request pool.
    if (clientUser.rowCount) {
      const serviceRequest = await client.query(
        `INSERT INTO service_requests(request_reference,client_user_id,category_id,title,description,budget_min,budget_max,currency,provider_action_minutes,status)
         VALUES('SR-DEMO-LEGAL',$1,$2,'Review a supplier agreement','I need an attorney to review a supplier agreement and highlight risky clauses before I sign it.',800,1800,'ZAR',30,'OPEN')
         ON CONFLICT(request_reference) DO UPDATE SET client_user_id=EXCLUDED.client_user_id,category_id=EXCLUDED.category_id,title=EXCLUDED.title,
           description=EXCLUDED.description,budget_min=EXCLUDED.budget_min,budget_max=EXCLUDED.budget_max,currency='ZAR',provider_action_minutes=30,
           status='OPEN',assigned_provider_id=NULL,provider_claimed_at=NULL,provider_action_deadline_at=NULL,accepted_quote_id=NULL,closed_at=NULL,updated_at=NOW()
         RETURNING id`,
        [clientUser.rows[0].id, categoryIds.legal]
      );
      await client.query(`DELETE FROM service_request_quotes WHERE service_request_id=$1`, [serviceRequest.rows[0].id]);
      await client.query(`DELETE FROM service_request_events WHERE service_request_id=$1`, [serviceRequest.rows[0].id]);
      await client.query(`INSERT INTO service_request_events(service_request_id,actor_user_id,event_type,to_status,details) VALUES($1,$2,'REQUEST_POSTED','OPEN','{"seed":true}')`, [serviceRequest.rows[0].id, clientUser.rows[0].id]);
    }

    const demoService = await client.query(`SELECT id,price,currency,duration_minutes FROM provider_services WHERE provider_id=$1 ORDER BY price LIMIT 1`, [doctorProfile.rows[0].id]);
    if (clientUser.rowCount && demoService.rowCount) {
      const starts = new Date(Date.now() + 10 * 60 * 1000);
      const ends = new Date(starts.getTime() + Number(demoService.rows[0].duration_minutes) * 60000);
      const existingDemo = await client.query(`SELECT id FROM appointments WHERE booking_reference='CH-DEMO-ROOM'`);
      let appointmentId;
      if (!existingDemo.rowCount) {
        const ar = await client.query(
          `INSERT INTO appointments(client_user_id,provider_id,service_id,starts_at,ends_at,status,payment_status,booking_reference,confirmed_at)
           VALUES($1,$2,$3,$4,$5,'CONFIRMED','PAID','CH-DEMO-ROOM',NOW()) RETURNING id`,
          [clientUser.rows[0].id, doctorProfile.rows[0].id, demoService.rows[0].id, starts, ends]
        );
        appointmentId = ar.rows[0].id;
      } else {
        appointmentId = existingDemo.rows[0].id;
        await client.query(`UPDATE appointments SET starts_at=$2,ends_at=$3,status='CONFIRMED',payment_status='PAID',confirmed_at=NOW(),hold_expires_at=NULL WHERE id=$1`, [appointmentId, starts, ends]);
      }
      await client.query(
        `INSERT INTO payments(appointment_id,client_user_id,provider_id,payment_reference,amount,currency,status,paid_at,metadata)
         VALUES($1,$2,$3,'PAY-DEMO-ROOM',$4,$5,'PAID',NOW(),'{"seed":true}')
         ON CONFLICT(payment_reference) DO UPDATE SET status='PAID',paid_at=NOW(),amount=EXCLUDED.amount`,
        [appointmentId, clientUser.rows[0].id, doctorProfile.rows[0].id, demoService.rows[0].price, demoService.rows[0].currency]
      );
      await client.query(
        `INSERT INTO consultation_rooms(appointment_id,room_code,status,opens_at,closes_at)
         VALUES($1,'ROOM-DEMO','READY',$2::timestamptz - INTERVAL '15 minutes',$3::timestamptz + INTERVAL '30 minutes')
         ON CONFLICT(appointment_id) DO UPDATE SET status='READY',opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,closed_at=NULL`,
        [appointmentId, starts, ends]
      );

      await client.query(`INSERT INTO appointment_workflows(appointment_id,workflow_key,intake_status,provider_clearance_status,room_access_status,state) VALUES($1,'MEDICAL','COMPLETE','NOT_REQUIRED','ALLOWED','{"seed":true}') ON CONFLICT(appointment_id) DO UPDATE SET workflow_key='MEDICAL',intake_status='COMPLETE',provider_clearance_status='NOT_REQUIRED',room_access_status='ALLOWED',updated_at=NOW()`,[appointmentId]);
      await client.query(`INSERT INTO medical_intakes(appointment_id,presenting_concern,symptoms,emergency_contact_name,emergency_contact_phone,location_during_consult,emergency_warning_ack,completed_by) VALUES($1,'Demo follow-up consultation','Demo symptoms','Demo Contact','+27 71 000 0098','Johannesburg',TRUE,$2) ON CONFLICT(appointment_id) DO UPDATE SET presenting_concern=EXCLUDED.presenting_concern,emergency_warning_ack=TRUE,completed_by=EXCLUDED.completed_by,updated_at=NOW()`,[appointmentId,clientUser.rows[0].id]);

      // Historical completed consultation with an approved review so ratings are visible immediately.
      const reviewStarts = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const reviewEnds = new Date(reviewStarts.getTime() + Number(demoService.rows[0].duration_minutes) * 60000);
      const historical = await client.query(
        `INSERT INTO appointments(client_user_id,provider_id,service_id,starts_at,ends_at,status,payment_status,booking_reference,confirmed_at,completed_at)
         VALUES($1,$2,$3,$4,$5,'COMPLETED','PAID','CH-DEMO-REVIEW',NOW()-INTERVAL '7 days',NOW()-INTERVAL '7 days')
         ON CONFLICT(booking_reference) DO UPDATE SET status='COMPLETED',payment_status='PAID',starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,completed_at=EXCLUDED.completed_at
         RETURNING id`,
        [clientUser.rows[0].id,doctorProfile.rows[0].id,demoService.rows[0].id,reviewStarts,reviewEnds]
      );
      await client.query(
        `INSERT INTO reviews(appointment_id,client_user_id,provider_id,rating,review_text,moderation_status,updated_at)
         VALUES($1,$2,$3,5,'Clear explanations and an easy booking experience.','APPROVED',NOW())
         ON CONFLICT(appointment_id) DO UPDATE SET rating=5,review_text=EXCLUDED.review_text,moderation_status='APPROVED',updated_at=NOW()`,
        [historical.rows[0].id,clientUser.rows[0].id,doctorProfile.rows[0].id]
      );

      const demoCase = await client.query(
        `INSERT INTO consultation_cases(case_reference,client_user_id,category_id,workflow_key,title,summary,originating_provider_id,current_provider_id,status)
         VALUES('CASE-DEMO-MEDICAL',$1,$2,'MEDICAL','Ongoing GP follow-up','Seeded continuity case used to test historical consultations and client-approved provider handover.',$3,$3,'OPEN')
         ON CONFLICT(case_reference) DO UPDATE SET client_user_id=EXCLUDED.client_user_id,category_id=EXCLUDED.category_id,current_provider_id=EXCLUDED.current_provider_id,updated_at=NOW()
         RETURNING id`,[clientUser.rows[0].id,categoryIds.medical,doctorProfile.rows[0].id]
      );
      await client.query(`UPDATE appointments SET case_id=$2 WHERE id=ANY($1::uuid[])`,[[appointmentId,historical.rows[0].id],demoCase.rows[0].id]);
      await client.query(`INSERT INTO case_provider_access(case_id,provider_id,access_level,granted_by_user_id) VALUES($1,$2,'ORIGINATING',$3) ON CONFLICT(case_id,provider_id) DO UPDATE SET access_level='ORIGINATING',revoked_at=NULL`,[demoCase.rows[0].id,doctorProfile.rows[0].id,clientUser.rows[0].id]);
    }

    await client.query('COMMIT');
    console.log('Seed completed. Demo password:', DEMO_PASSWORD);
    console.log('Admin: admin@consulthub.local');
    console.log('Pending provider: pending@consulthub.local');
    console.log('IT provider: it@consulthub.local');
    console.log('Second medical provider for handover testing: doctor2@consulthub.local');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
