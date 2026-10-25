const { contextBridge } = require('electron');

const prefix = '--review-data=';
const argument = process.argv.find((value) => value.startsWith(prefix));
if (!argument) throw new Error('缺少审查数据');

const data = JSON.parse(decodeURIComponent(argument.slice(prefix.length)));
contextBridge.exposeInMainWorld('reviewData', Object.freeze(data));
