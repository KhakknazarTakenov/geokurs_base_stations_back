import express from 'express';
import Client from 'ssh2-sftp-client';
import { logMessage } from './logger/logger.js';
import './global.js';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors({origin: "*"}));

const sftpConfig = {
    host: 'storerobots.gamechanger.kz',
    port: 22,
    username: 'root',
    password: 'GaMeChangerSERVE@2024'
};

const BASE_URL = "/geokurs_base_stations/"

const usersAutPath = "/home/tmp/USERS.aut";
const groupsAutPath = "/home/tmp/GROUPS.aut";
const mountsAutPath = "/home/tmp/clientmounts.aut";

// Генерация логина и пароля
function generateCredentials() {
    const login = `${Math.random().toString(36).slice(2, 10)}`;
    const password = Math.random().toString(36).slice(2, 10).toUpperCase();
    return { login, password };
}

// Генерация группировки
function generateGroup(login) {
    return `g${login}`;
}

// Эндпоинт для записи данных и активации подписки
app.post(BASE_URL + 'activate', async (req, res) => {
    const { serial, tariff, stations, login, password, group } = req.body;
    const sftp = new Client();

    try {
        await sftp.connect(sftpConfig);

        // Генерация данных, если не переданы
        const finalLogin = login || generateCredentials().login;
        const finalPassword = password || generateCredentials().password;
        const finalGroup = group || generateGroup(finalLogin);

        // Валидация входных данных
        if (!serial || !stations || !Array.isArray(stations)) {
            throw new Error('Invalid input: serial, and stations are required, and stations must be an array');
        }

        for (const station of stations) {
            if (!station.name || !station.formats || !Array.isArray(station.formats)) {
                throw new Error(`Invalid station data: ${JSON.stringify(station)}. Name and formats are required, and formats must be an array`);
            }
        }

        // Чтение и нормализация содержимого USERS.aut
        let usersContent = await sftp.get(usersAutPath).then(data => data.toString()).catch(() => '');
        let usersLines = usersContent.trim().split('\n').filter(line => line.trim()); // Разделяем на строки и убираем пустые

        // Проверка на дубли
        if (usersLines.some(line => line.startsWith(`${finalLogin}:`))) {
            throw new Error(`Login ${finalLogin} already exists`);
        }

        // Добавляем новую строку
        usersLines.push(`${finalLogin}:${finalPassword}`);
        usersContent = usersLines.join('\n') + '\n'; // Собираем строки с переносами
        await sftp.put(Buffer.from(usersContent), usersAutPath);
        await logMessage(LOG_TYPES.I, 'manageDevice 56', `Added user ${finalLogin}:${finalPassword} to USERS.aut for serial ${serial}`);

        // Чтение и нормализация содержимого GROUPS.aut
        let groupsContent = await sftp.get(groupsAutPath).then(data => data.toString()).catch(() => '');
        let groupsLines = groupsContent.trim().split('\n').filter(line => line.trim()); // Разделяем на строки и убираем пустые

        // Добавляем новую строку
        groupsLines.push(`${finalGroup}:${finalLogin}:1`);
        groupsContent = groupsLines.join('\n') + '\n'; // Собираем строки с переносами
        await sftp.put(Buffer.from(groupsContent), groupsAutPath);
        await logMessage(LOG_TYPES.I, 'manageDevice 62', `Added group ${finalGroup}:${finalLogin}:1 to GROUPS.aut for serial ${serial}`);

        // Работа с clientmounts.aut
        let mountsContent = await sftp.get(mountsAutPath).then(data => data.toString()).catch(() => '');
        const lines = mountsContent.split('\n').filter(line => line.trim());

        // Парсинг файла в структуру
        const stationsMap = new Map(); // { station: { format: groups } }
        let currentStation = null;
        for (const line of lines) {
            if (line.startsWith('#')) {
                currentStation = line.slice(1);
                if (!stationsMap.has(currentStation)) {
                    stationsMap.set(currentStation, new Map());
                }
            } else if (currentStation && line) {
                const [format, groups = ''] = line.split(':');
                stationsMap.get(currentStation).set(format, groups.split(',').filter(g => g));
            }
        }

        // Обновление станций и форматов
        for (const station of stations) {
            const stationName = station.name;
            if (!stationsMap.has(stationName)) {
                stationsMap.set(stationName, new Map());
            }
            const formatsMap = stationsMap.get(stationName);
            for (const format of station.formats) {
                // Убедимся, что форматы переданы без `/` и `:`
                const cleanFormat = format.startsWith('/') ? format.slice(1) : format;
                const finalFormat = cleanFormat.endsWith(':') ? cleanFormat.slice(0, -1) : cleanFormat;
                const groups = formatsMap.get(finalFormat) || [];
                if (!groups.includes(finalGroup)) {
                    groups.push(finalGroup);
                }
                formatsMap.set(finalFormat, groups);
            }
        }

        // Формирование нового содержимого
        let updatedLines = [];
        for (const [station, formatsMap] of stationsMap) {
            if (formatsMap.size > 0) {
                updatedLines.push(`#${station}`);
                for (const [format, groups] of formatsMap) {
                    if (groups.length > 0) {
                        updatedLines.push(`${format}:${groups.join(',')},`);
                    }
                }
            }
        }

        mountsContent = updatedLines.join('\n') + '\n';
        await sftp.put(Buffer.from(mountsContent), mountsAutPath);
        await logMessage(LOG_TYPES.I, 'manageDevice 77', `Added mounts for group ${finalGroup} to clientmounts.aut for serial ${serial}`);

        res.json({ success: true, login: finalLogin, password: finalPassword, group: finalGroup });
    } catch (error) {
        await logMessage(LOG_TYPES.E, 'manageDevice 81', `Failed to manage device for serial ${serial}: ${error.message}`);
        res.status(500).json({ error: error.message });
    } finally {
        await sftp.end();
    }
});

// Эндпоинт для деактивации подписки
app.post(BASE_URL + 'deactivate', async (req, res) => {
    const login = (req.query && req.query.login) || (req.params && req.params.login) || (req.body && req.body.login) || '';
    const group = (req.query && req.query.group) || (req.params && req.params.group) || (req.body && req.body.group) || '';

    const sftp = new Client();

    try {
        await sftp.connect(sftpConfig);

        // Удаление из USERS.aut
        let usersContent = await sftp.get(usersAutPath).then(data => data.toString());
        if (!usersContent.includes(`${login}:`)) {
            throw new Error(`Login ${login} not found`);
        }
        const escapedLogin = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        usersContent = usersContent.replace(new RegExp(`${escapedLogin}:.*\\n`, 'g'), '');
        await sftp.put(Buffer.from(usersContent), usersAutPath);
        await logMessage(LOG_TYPES.I, 'deactivate 103', `Removed user ${login} from USERS.aut`);

        // Удаление из GROUPS.aut
        let groupsContent = await sftp.get(groupsAutPath).then(data => data.toString());
        const escapedGroup = group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        groupsContent = groupsContent.replace(new RegExp(`${escapedGroup}:.*\\n`, 'g'), '');
        await sftp.put(Buffer.from(groupsContent), groupsAutPath);
        await logMessage(LOG_TYPES.I, 'deactivate 109', `Removed group ${group} from GROUPS.aut`);

        // Удаление из clientmounts.aut
        let mountsContent = await sftp.get(mountsAutPath).then(data => data.toString());
        const lines = mountsContent.split('\n').filter(line => line.trim());
        const stationsMap = new Map(); // { station: { format: groups } }
        let currentStation = null;

        // Парсинг файла в структуру
        for (const line of lines) {
            if (line.startsWith('#')) {
                currentStation = line.slice(1);
                if (!stationsMap.has(currentStation)) {
                    stationsMap.set(currentStation, new Map());
                }
            } else if (currentStation && line) {
                const [format, groups = ''] = line.split(':');
                const updatedGroups = groups
                    .split(',')
                    .filter(g => g && g !== group);
                if (updatedGroups.length > 0) {
                    stationsMap.get(currentStation).set(format, updatedGroups);
                }
            }
        }

        // Формирование нового содержимого
        let updatedLines = [];
        for (const [station, formatsMap] of stationsMap) {
            if (formatsMap.size > 0) {
                updatedLines.push(`#${station}`);
                for (const [format, groups] of formatsMap) {
                    updatedLines.push(`${format}:${groups.join(',')},`);
                }
            }
        }

        mountsContent = updatedLines.join('\n') + '\n';
        await sftp.put(Buffer.from(mountsContent), mountsAutPath);
        await logMessage(LOG_TYPES.I, 'deactivate 115', `Removed group ${group} from clientmounts.aut`);

        res.json({ success: true });
    } catch (error) {
        await logMessage(LOG_TYPES.E, 'deactivate 119', `Failed to deactivate for login ${login}: ${error.message}`);
        res.status(500).json({ error: error.message });
    } finally {
        await sftp.end();
    }
});

app.listen(3456, async () => {
    console.log('Server running on port 3456');
    await logMessage(LOG_TYPES.I, 'STARTUP', 'Server started on port 1234');
});