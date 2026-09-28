import React,{useEffect,useState}from'react';
import{api,getToken,setSession}from'./api';

function initials(user){return `${user?.firstName?.[0]||''}${user?.lastName?.[0]||''}`.toUpperCase()||'U'}

export default function AccountProfile({user,onUser,setPage}){
  const[form,setForm]=useState({firstName:user?.firstName||'',lastName:user?.lastName||'',phone:user?.phone||''});
  const[error,setError]=useState('');
  const[message,setMessage]=useState('');
  const[saving,setSaving]=useState(false);

  useEffect(()=>{setForm({firstName:user?.firstName||'',lastName:user?.lastName||'',phone:user?.phone||''})},[user?.firstName,user?.lastName,user?.phone]);

  const change=e=>setForm({...form,[e.target.name]:e.target.value});

  async function save(e){
    e.preventDefault();setError('');setMessage('');setSaving(true);
    try{
      const d=await api('/auth/me',{method:'PATCH',body:JSON.stringify(form)});
      setSession(getToken(),d.user);
      onUser(d.user);
      setMessage('Your profile details have been updated.');
    }catch(e){setError(e.message)}finally{setSaving(false)}
  }

  return <section className="page profile-page">
    <div className="heading">
      <div><div className="eyebrow">MY ACCOUNT</div><h2>Profile & personal details</h2><p className="profile-intro">Keep your contact details current so Consult Fundi can send the right account and consultation notifications.</p></div>
      <div className="profile-avatar-large">{initials(user)}</div>
    </div>

    <div className="profile-layout">
      <form className="card profile-form" onSubmit={save}>
        <div className="section-title"><div><h3>Personal details</h3><p className="muted">These details belong to your Consult Fundi account.</p></div><span className="status verified">{user.role}</span></div>
        {error&&<div className="alert">{error}</div>}{message&&<div className="success">{message}</div>}
        <div className="two">
          <label>First name<input name="firstName" value={form.firstName} onChange={change} required maxLength="80"/></label>
          <label>Last name<input name="lastName" value={form.lastName} onChange={change} required maxLength="80"/></label>
        </div>
        <label>Email address<input value={user.email||''} readOnly className="readonly-input"/><small>Email changes will use a separate re-verification flow; they are intentionally disabled here for account security.</small></label>
        <label>Mobile number<input name="phone" value={form.phone} onChange={change} placeholder="e.g. +27 82 123 4567" maxLength="40"/><small>{user.phoneVerified?'✓ Mobile number verified':'Mobile number not yet verified.'}</small></label>
        <div className="profile-actions"><button className="btn" disabled={saving}>{saving?'Saving…':'Save changes'}</button><button type="button" className="btn secondary" onClick={()=>setPage('security')}>Security settings</button></div>
      </form>

      <aside className="card profile-side">
        <h3>Account</h3>
        <div className="profile-summary"><div className="avatar">{initials(user)}</div><div><b>{user.firstName} {user.lastName}</b><span>{user.email}</span></div></div>
        <div className="profile-meta"><div><span>Account type</span><b>{user.role}</b></div><div><span>Email</span><b>{user.emailVerified?'Verified':'Verification required'}</b></div><div><span>Phone</span><b>{user.phoneVerified?'Verified':'Not verified'}</b></div></div>
        {user.role==='PROVIDER'&&<><hr/><p className="muted">Your profession, biography, practice information and consultation services are maintained separately from your personal account details.</p><button className="btn secondary full" onClick={()=>setPage('professionalSetup')}>Professional profile</button></>}
        {user.role==='ADMIN'&&<><hr/><p className="muted">Administrative access and account security remain managed through the security and admin areas.</p></>}
      </aside>
    </div>
  </section>
}
