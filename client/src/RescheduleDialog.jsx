import React,{useEffect,useMemo,useState}from'react';
import{api}from'./api';
import'./reschedule.css';

const pad=n=>String(n).padStart(2,'0');
const dateInputValue=value=>{
  const d=value?new Date(value):new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
};
const datePlus=days=>{
  const d=new Date();
  d.setHours(12,0,0,0);
  d.setDate(d.getDate()+days);
  return dateInputValue(d);
};
const dateLabel=value=>new Intl.DateTimeFormat('en-ZA',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}).format(new Date(value));
const timeLabel=value=>new Intl.DateTimeFormat('en-ZA',{hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const fullLabel=value=>new Intl.DateTimeFormat('en-ZA',{weekday:'short',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));

function SlotGroup({title,slots,selected,onSelect}){
  if(!slots.length)return null;
  return <div className="reschedule-slot-group">
    <div className="reschedule-slot-heading">{title}</div>
    <div className="reschedule-slots">
      {slots.map(slot=><button type="button" key={slot} className={`reschedule-slot ${selected===slot?'selected':''}`} onClick={()=>onSelect(slot)}>{timeLabel(slot)}</button>)}
    </div>
  </div>;
}

export default function RescheduleDialog({appointment,user,onClose,onDone}){
  const[date,setDate]=useState(dateInputValue(appointment.starts_at));
  const[slots,setSlots]=useState([]);
  const[selected,setSelected]=useState('');
  const[loading,setLoading]=useState(false);
  const[saving,setSaving]=useState(false);
  const[error,setError]=useState('');

  const counterpart=user.role==='PROVIDER'
    ?`${appointment.client_first_name} ${appointment.client_last_name}`
    :`${appointment.provider_first_name} ${appointment.provider_last_name}`;

  useEffect(()=>{
    const onKey=e=>{if(e.key==='Escape'&&!saving)onClose()};
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[saving,onClose]);

  useEffect(()=>{
    let active=true;
    setSelected('');
    setError('');
    setLoading(true);
    api(`/providers/${appointment.provider_id}/slots?date=${date}&serviceId=${appointment.service_id}`)
      .then(d=>{if(active)setSlots(d.slots||[])})
      .catch(e=>{if(active){setSlots([]);setError(e.message)}})
      .finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[appointment.provider_id,appointment.service_id,date]);

  const groups=useMemo(()=>{
    const by={Morning:[],Afternoon:[],Evening:[]};
    for(const slot of slots){
      const hour=new Date(slot).getHours();
      if(hour<12)by.Morning.push(slot);
      else if(hour<17)by.Afternoon.push(slot);
      else by.Evening.push(slot);
    }
    return by;
  },[slots]);

  async function confirm(){
    if(!selected||saving)return;
    setSaving(true);setError('');
    try{
      await api(`/appointments/${appointment.id}/reschedule`,{method:'POST',body:JSON.stringify({startsAt:selected})});
      await onDone(selected);
    }catch(e){
      setError(e.message);
      setSaving(false);
    }
  }

  const quickDates=[
    ['Today',datePlus(0)],
    ['Tomorrow',datePlus(1)],
    ['+2 days',datePlus(2)],
    ['+7 days',datePlus(7)]
  ];

  return <div className="reschedule-overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget&&!saving)onClose()}}>
    <section className="reschedule-dialog" role="dialog" aria-modal="true" aria-labelledby="reschedule-title">
      <div className="reschedule-header">
        <div>
          <div className="reschedule-eyebrow">RESCHEDULE APPOINTMENT</div>
          <h3 id="reschedule-title">Choose a better time</h3>
          <p>{user.role==='PROVIDER'?`Select a new available time for ${counterpart}.`:`Select another available time with ${counterpart}.`}</p>
        </div>
        <button type="button" className="reschedule-close" aria-label="Close reschedule dialog" onClick={onClose} disabled={saving}>×</button>
      </div>

      <div className="reschedule-current">
        <div>
          <span>Current appointment</span>
          <b>{fullLabel(appointment.starts_at)}</b>
          <small>{appointment.service_name} · {appointment.booking_reference||'No booking reference'}</small>
        </div>
        <div className="reschedule-state">
          <span className={`reschedule-pill ${String(appointment.status||'').toLowerCase()}`}>{appointment.status}</span>
          <span className={`reschedule-pill ${String(appointment.payment_status||'').toLowerCase()}`}>{appointment.payment_status}</span>
        </div>
      </div>

      <div className="reschedule-body">
        <div className="reschedule-step">
          <div className="reschedule-step-number">1</div>
          <div className="reschedule-step-content">
            <div className="reschedule-step-title"><b>Select a date</b><span>Availability is checked against the provider calendar.</span></div>
            <div className="reschedule-quick-dates">
              {quickDates.map(([label,value])=><button type="button" key={label} className={date===value?'active':''} onClick={()=>setDate(value)}><b>{label}</b><span>{new Intl.DateTimeFormat('en-ZA',{day:'2-digit',month:'short'}).format(new Date(`${value}T12:00:00`))}</span></button>)}
            </div>
            <label className="reschedule-date-field">Or choose another date<input type="date" value={date} min={datePlus(0)} onChange={e=>setDate(e.target.value)}/></label>
          </div>
        </div>

        <div className="reschedule-step">
          <div className="reschedule-step-number">2</div>
          <div className="reschedule-step-content">
            <div className="reschedule-step-title"><b>Select a time</b><span>{dateLabel(`${date}T12:00:00`)}</span></div>
            {loading?<div className="reschedule-loading"><span></span>Checking available times…</div>:<>
              {error&&<div className="reschedule-error">{error}</div>}
              {!error&&!slots.length&&<div className="reschedule-empty"><b>No available times on this date.</b><span>Try another day using the date options above.</span></div>}
              <SlotGroup title="Morning" slots={groups.Morning} selected={selected} onSelect={setSelected}/>
              <SlotGroup title="Afternoon" slots={groups.Afternoon} selected={selected} onSelect={setSelected}/>
              <SlotGroup title="Evening" slots={groups.Evening} selected={selected} onSelect={setSelected}/>
            </>}
          </div>
        </div>

        {selected&&<div className="reschedule-preview">
          <div className="reschedule-preview-icon">✓</div>
          <div className="reschedule-preview-copy">
            <span>Review the change</span>
            <div className="reschedule-change-row"><div><small>FROM</small><b>{fullLabel(appointment.starts_at)}</b></div><span>→</span><div><small>TO</small><b>{fullLabel(selected)}</b></div></div>
            <p>{appointment.status==='CONFIRMED'?'The appointment remains confirmed.':'The appointment remains pending and its payment hold will refresh.'} Both participants will receive an updated notification.</p>
          </div>
        </div>}
      </div>

      <div className="reschedule-footer">
        <button type="button" className="reschedule-cancel" onClick={onClose} disabled={saving}>Keep current time</button>
        <button type="button" className="reschedule-confirm" onClick={confirm} disabled={!selected||loading||saving}>{saving?'Updating appointment…':'Confirm new time'}</button>
      </div>
    </section>
  </div>;
}
