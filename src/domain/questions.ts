import crypto from 'node:crypto';
import type { Question } from '../types/domain';

const QUESTION_POOL: Question[] = [
  { id: 1,  text: "Pick a number.", type: "select", category: "number", options: ["1","2","3","4","5","6","7","8","9","10"] },
  { id: 2,  text: "Pick a Fibonacci number.", type: "select", category: "number", options: ["1","2","3","5","8","13","21","34","55","89"] },
  { id: 3,  text: "Pick a perfect square.", type: "select", category: "number", options: ["1","4","9","16","25","36","49","64","81","100"] },
  { id: 4,  text: "Pick a prime number.", type: "select", category: "number", options: ["2","3","5","7","11","13","17","19","23","29","31","37"] },
  { id: 5,  text: "Pick a multiple of ten.", type: "select", category: "number", options: ["10","20","30","40","50","60","70","80","90","100"] },
  { id: 6,  text: "Pick a digit.", type: "select", category: "number", options: ["0","1","2","3","4","5","6","7","8","9"] },
  { id: 7,  text: "Pick a number.", type: "select", category: "number", options: ["3","7","12","22","35","42","58","69","77","88","91","100"] },
  { id: 8,  text: "Pick a probability.", type: "select", category: "number", options: ["0.01","0.05","0.10","0.25","0.33","0.50","0.67","0.75","0.90","0.95","0.99"] },
  { id: 9,  text: "Pick a power of two.", type: "select", category: "number", options: ["1","2","4","8","16","32","64","128","256","512","1024"] },
  { id: 10, text: "Pick a number.", type: "select", category: "number", options: ["1","2","3","4","5","6","7","8","9","1000"] },
  { id: 11, text: "Pick a number.", type: "select", category: "number", options: ["-50","-20","-10","-5","-1","0","1","5","10","20","50"] },
  { id: 12, text: "Pick a repeating number.", type: "select", category: "number", options: ["11","22","33","44","55","66","77","88","99","111"] },
  { id: 13, text: "Pick a decimal.", type: "select", category: "number", options: ["0.0","0.1","0.2","0.3","0.4","0.5","0.6","0.7","0.8","0.9","1.0"] },
  { id: 14, text: "Pick a constant.", type: "select", category: "number", options: ["0","1","e (2.72)","pi (3.14)","phi (1.62)","sqrt2 (1.41)","ln2 (0.69)","42","infinity","-1"] },
  { id: 15, text: "Pick a percentage.", type: "select", category: "number", options: ["0%","10%","20%","30%","40%","50%","60%","70%","80%","90%","100%"] },
  { id: 16, text: "Pick the best age to be.", type: "select", category: "lifestyle", options: ["5","10","16","18","21","25","30","40","50","65","80"] },
  { id: 17, text: "Pick the best time of day.", type: "select", category: "lifestyle", options: ["06:00","07:00","08:00","10:00","12:00","14:00","17:00","19:00","20:00","22:00","00:00"] },
  { id: 18, text: "Pick the best month.", type: "select", category: "lifestyle", options: ["January","February","March","April","May","June","July","August","September","October","November","December"] },
  { id: 19, text: "Pick the best day of the week.", type: "select", category: "lifestyle", options: ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"] },
  { id: 20, text: "Pick the decade with the best music.", type: "select", category: "culture", options: ["1920s","1930s","1940s","1950s","1960s","1970s","1980s","1990s","2000s","2010s","2020s"] },
  { id: 21, text: "How long should a perfect vacation last?", type: "select", category: "lifestyle", options: ["1 day","3 days","1 week","2 weeks","1 month","3 months","6 months","1 year","5 years","Forever"] },
  { id: 22, text: "Pick the most powerful human emotion.", type: "select", category: "psychology", options: ["Joy","Sadness","Anger","Fear","Surprise","Disgust","Love","Hope","Curiosity","Peace"] },
  { id: 23, text: "Pick the best superpower.", type: "select", category: "fantasy", options: ["Flight","Invisibility","Teleportation","Time travel","Mind reading","Super strength","Immortality","Shapeshifting","Telekinesis","Healing others"] },
  { id: 24, text: "If you could eat only one food forever, which?", type: "select", category: "lifestyle", options: ["Rice","Bread","Potato","Pasta","Corn","Chicken","Beef","Fish","Eggs","Cheese"] },
  { id: 25, text: "Which sense is most important?", type: "select", category: "psychology", options: ["Smell","Taste","Touch","Hearing","Sight"] },
  { id: 26, text: "Pick the most interesting number.", type: "select", category: "number", options: ["Zero","One","Two","Three","Five","Seven","Ten","Twelve","Thirteen","Forty-two","Hundred","Infinity"] },
  { id: 27, text: "Pick the most important virtue.", type: "select", category: "philosophy", options: ["Courage","Wisdom","Justice","Temperance","Honesty","Compassion","Loyalty","Humility","Patience","Gratitude"] },
  { id: 28, text: "Pick the most universal human fear.", type: "select", category: "psychology", options: ["Heights","Darkness","Spiders","Snakes","Death","Loneliness","Failure","Deep water","Public speaking","The unknown"] },
  { id: 29, text: "Pick the most beautiful color.", type: "select", category: "aesthetics", options: ["Red","Orange","Yellow","Green","Teal","Blue","Indigo","Violet","Pink","Gold","Black","White"] },
  { id: 30, text: "Pick the most beautiful time of year.", type: "select", category: "aesthetics", options: ["Early spring","Late spring","Early summer","Midsummer","Late summer","Early autumn","Mid autumn","Late autumn","Early winter","Midwinter"] },
  { id: 31, text: "Pick the most beautiful-sounding instrument.", type: "select", category: "aesthetics", options: ["Piano","Guitar","Violin","Cello","Flute","Trumpet","Saxophone","Harp","Drums","Human voice"] },
  { id: 32, text: "Pick the word that best describes life.", type: "select", category: "philosophy", options: ["Always","Never","Sometimes","Maybe","Definitely","Probably","Rarely","Often","Impossible","Unpredictable"] },
  { id: 33, text: "Pick what matters most.", type: "select", category: "philosophy", options: ["Freedom","Security","Love","Power","Knowledge","Peace","Wealth","Health","Truth","Beauty"] },
  { id: 34, text: "Pick the fundamental principle of the universe.", type: "select", category: "philosophy", options: ["Order","Chaos","Balance","Change","Stillness","Growth","Decay","Cycles","Entropy","Emergence"] },
  { id: 35, text: "Pick the most important concept.", type: "select", category: "philosophy", options: ["Past","Present","Future","Moment","Eternity","Memory","Dream","Now","Change","Permanence"] },
  { id: 36, text: "Pick the warmest color.", type: "select", category: "aesthetics", options: ["White","Light yellow","Yellow","Gold","Orange","Coral","Red","Crimson","Maroon","Brown","Dark brown","Black"] },
  { id: 37, text: "Pick the coldest color.", type: "select", category: "aesthetics", options: ["White","Ice blue","Light cyan","Cyan","Teal","Blue","Navy","Indigo","Dark purple","Charcoal","Black"] },
  { id: 38, text: "Pick the shade that best represents 'neutral'.", type: "select", category: "aesthetics", options: ["White","Ivory","Light gray","Silver","Gray","Slate","Dark gray","Charcoal","Near-black","Black"] },
  { id: 39, text: "Pick the color of trust.", type: "select", category: "aesthetics", options: ["Red","Orange","Yellow","Green","Teal","Blue","Indigo","Violet","White","Gold","Black","Gray"] },
  { id: 40, text: "Pick the color of danger.", type: "select", category: "aesthetics", options: ["White","Yellow","Gold","Orange","Coral","Red","Crimson","Maroon","Dark red","Black"] },
  { id: 41, text: "Pick the most calming color.", type: "select", category: "aesthetics", options: ["White","Lavender","Light blue","Sky blue","Mint","Sage","Seafoam","Teal","Periwinkle","Soft pink","Cream","Gray"] },
  { id: 42, text: "Pick the color that represents 'moderate'.", type: "select", category: "aesthetics", options: ["Pure red","Warm red","Orange-red","Orange","Amber","Neutral","Teal","Cool blue","Blue","Deep blue"] },
  { id: 43, text: "Pick the color of intelligence.", type: "select", category: "aesthetics", options: ["Red","Orange","Yellow","Green","Teal","Blue","Indigo","Violet","Silver","Gold","White","Black"] },
  { id: 44, text: "Pick the color of money.", type: "select", category: "aesthetics", options: ["White","Cream","Light green","Green","Dark green","Gold","Silver","Brown","Blue","Black"] },
  { id: 45, text: "Pick the color of the future.", type: "select", category: "aesthetics", options: ["White","Silver","Light blue","Cyan","Teal","Electric blue","Purple","Violet","Neon green","Chrome","Black"] },
];

export function getPublicPool(): Question[] {
  return JSON.parse(JSON.stringify(QUESTION_POOL));
}

export function selectQuestionsForMatch(count = 10): Question[] {
  const pool = getPublicPool();
  if (count > pool.length) {
    throw new RangeError(
      `Requested ${count} questions but pool only has ${pool.length}`
    );
  }

  // Fisher-Yates shuffle using crypto randomness
  for (let i = pool.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0]! % (i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  return pool.slice(0, count);
}

export function validatePool(): boolean {
  return QUESTION_POOL.every(
    q => q.type === 'select' && Array.isArray(q.options) && q.options.length > 0
  );
}

export default QUESTION_POOL;
