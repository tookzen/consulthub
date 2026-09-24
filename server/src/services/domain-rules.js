const WORKFLOW_DEFAULTS={
  MEDICAL:{intake:'REQUIRED',clearance:'NOT_REQUIRED'},
  LEGAL:{intake:'REQUIRED',clearance:'PENDING'},
  TECHNOLOGY:{intake:'REQUIRED',clearance:'NOT_REQUIRED'},
  GENERAL:{intake:'NOT_REQUIRED',clearance:'NOT_REQUIRED'}
};
function workflowDefaults(key){return WORKFLOW_DEFAULTS[key]||WORKFLOW_DEFAULTS.GENERAL;}
function roomAccessAllowed({intakeStatus,providerClearanceStatus}){
  return ['NOT_REQUIRED','COMPLETE'].includes(intakeStatus)&&['NOT_REQUIRED','CLEARED'].includes(providerClearanceStatus);
}
function calculatePaymentSplit(amount,{percentage=10,fixedAmount=0}={}){
  const gross=Math.max(0,Number(amount||0));
  const platform=Math.min(gross,Math.round((gross*Number(percentage||0)/100+Number(fixedAmount||0))*100)/100);
  return {gross,platformFee:platform,providerNet:Math.round((gross-platform)*100)/100};
}
function completedAppointmentReviewAllowed({status,clientUserId,userId}){return status==='COMPLETED'&&clientUserId===userId;}
module.exports={WORKFLOW_DEFAULTS,workflowDefaults,roomAccessAllowed,calculatePaymentSplit,completedAppointmentReviewAllowed};
