const path = require('path');

const APP_NAME = '鬼鬼聚合';
const APP_NAME_ZH = '账号聚合';
const APP_ID = 'com.trae.hop';
const APP_SLUG = 'traehop';
const DATA_STORE_NAME = 'traehop-data';
const BACKUP_FORMAT = 'traehop';

function getIconPath() {
  return path.join(__dirname, '../build/icon.png');
}

module.exports = {
  APP_NAME,
  APP_NAME_ZH,
  APP_ID,
  APP_SLUG,
  DATA_STORE_NAME,
  BACKUP_FORMAT,
  getIconPath,
};
