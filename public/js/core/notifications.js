export function createNotifications(find) {
  return {
    toast(message, type="success") {
      const target=find("#toast");target.textContent=message;target.className=`toast ${type==="success"?"success":"error-toast"}`;
      setTimeout(()=>target.classList.add("hidden"),3500);
    },
    showError(target,message) { target.textContent=message;target.classList.remove("hidden"); },
  };
}
