window.emergencyPlan = {
  A: {
    room: 'N',
    start: '13:15',
    note: 'INC-04 M关闭，138人仅N(150)可容；N 13:15交场，推迟15min≤15min上限（CAP-01,RUN-02,TECH-03）',
  },
  B: { room: 'W', start: '13:10', note: '实操时地固定，不受M关闭影响（RUN-02）' },
  C: {
    room: 'S',
    start: '14:15',
    note: 'M关闭后需转播切换：A结束14:00+15min切换=14:15最早；88人≤S(96)可转播，推迟15min≤25min（TECH-03,CAP-01,RUN-02）',
  },
  D: {
    room: 'N',
    start: '14:15',
    note: '时间固定，104人仅N(150)可容；A 14:00结束+10min清场=14:10，14:15合规（CAP-01,RUN-02,INC-04）',
  },
  E: {
    room: 'W',
    start: '14:30',
    note: '实操时地固定，不受M关闭影响；B 14:10结束+10min=14:20，14:30合规（RUN-02）',
  },
  F: {
    room: 'N',
    start: '15:30',
    note: '时间固定，110人仅N(150)可容；D 15:00结束+10min=15:10，15:30合规（CAP-01,RUN-02,INC-04）',
  },
};
