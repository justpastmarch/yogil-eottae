type GradeBand = {
  readonly className: string;
  readonly color: string;
  readonly label: string;
  readonly below: number;
};

export const GRADE_BANDS = [
  {className:'grade-low',color:'#176b55',label:'10% 미만',below:10},
  {className:'grade-medium',color:'#eab308',label:'10% 이상 20% 미만',below:20},
  {className:'grade-high',color:'#ef4444',label:'20% 이상',below:Infinity},
] as const satisfies readonly GradeBand[];

export const UNKNOWN_GRADE = {className:'grade-unknown',color:'#8b95a3',label:'자료 없음'} as const;

export function gradeBand(gradePercent:number|null|undefined):typeof GRADE_BANDS[number]|typeof UNKNOWN_GRADE {
  if(gradePercent===null||gradePercent===undefined||!Number.isFinite(gradePercent))return UNKNOWN_GRADE;
  const magnitude=Math.abs(gradePercent);
  for(const band of GRADE_BANDS)if(magnitude<band.below)return band;
  return UNKNOWN_GRADE;
}
