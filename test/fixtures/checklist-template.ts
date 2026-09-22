export const templateFixture = {
  name_snapshot: "Technical test", sections: [
    { stable_key: "SUP_APP", name: "SUP/APP", sort_order: 0, active: true, service_name: "CES", object_name: "Bakı", items: [
      { stable_key: "MONITOR", name: "Monitor", equipment_name: "SDD", technology_card: "S1,H1,İ1", sort_order: 0, active: true, required: true },
      { stable_key: "PHONE", name: "Phone", equipment_name: "EMG", technology_card: "H1", sort_order: 1, active: false, required: false },
    ] },
    { stable_key: "UCS2", name: "UCS2", sort_order: 1, active: true, service_name: "Rabitə", object_name: "Tower", items: [
      { stable_key: "VCS", name: "VCS", equipment_name: "UCS2", technology_card: "S1,H1,İ1", sort_order: 0, active: true, required: true },
    ] },
  ],
};
