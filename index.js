import express, {urlencoded} from 'express';
import Client from 'ssh2-sftp-client';
import { logMessage } from './logger/logger.js';
import './global.js';
import cors from 'cors';
import {decryptText, encryptText, generateCryptoKeyAndIV} from "./crypto.js";
import path from "path";
import fs from "fs";
import * as dotenv from "dotenv";

const envPath = path.join(process.cwd(), '.env');
dotenv.config({ path: envPath });

const app = express();
app.use(express.json());
app.use(cors({origin: "*"}));

const sftpConfig = {
    host: process.env.SFTP_HOST,
    port: process.env.SFTP_PORT,
    username: process.env.SFTP_USERNAME,
    password: process.env.SFTP_PASSWORD
};

const BASE_URL = "/geokurs_base_stations/"

const usersAutPath = "/home/tmp/USERS.aut";
const groupsAutPath = "/home/tmp/GROUPS.aut";
const mountsAutPath = "/home/tmp/clientmounts.aut";

const generateCredentials = () => {
    // Исходный набор символов
    let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    // Исключаем символы: I, i, l, L, 1, o, O, 0
    const excludedChars = /[IiLl1oO0]/g;
    characters = characters.replace(excludedChars, '');

    // Проверяем, что после фильтрации остались символы
    if (characters.length === 0) {
        throw new Error('No characters available for generating credentials after filtering.');
    }

    const length = 8;
    let login = '';
    let password = '';

    // Генерация логина
    for (let i = 0; i < length; i++) {
        login += characters.charAt(Math.floor(Math.random() * characters.length));
    }

    // Генерация пароля
    for (let i = 0; i < length; i++) {
        password += characters.charAt(Math.floor(Math.random() * characters.length));
    }

    return { login, password };
};

// Генерация группировки
function generateGroup(login) {
    return `g${login}`;
}

const updateProductStationListUserfield = async (newStationTitle) => {
    try {
        const bxLinkDecrypted = await decryptText(process.env.BX_LINK, process.env.CRYPTO_KEY, process.env.CRYPTO_IV);
        const productFields = await (await fetch(`${bxLinkDecrypted}/crm.item.fields?entityTypeId=177`)).json();
        const productFieldsData = productFields.result.fields;
        if (!productFieldsData) {
            throw new Error("Product fields not found!")
        }
        const stationsField = productFieldsData.ufCrm6_1730973093114 || null;
        // const stationsField = productFieldsData.ufCrm6_1748266035070 || null;

        if (!stationsField) {
            throw new Error("Such field not found. Tried to find: ufCrm6_1730973093114")
        }

        const existingStationsList = stationsField.items;

        if (existingStationsList.find(station => station.VALUE.toLowerCase().trim().replace(/[^\wа-яА-Я0-9]/g, "") === newStationTitle.toLowerCase().trim().replace(/[^\wа-яА-Я0-9]/g, ""))) {
            throw new Error(`Station ${newStationTitle} is already in list!`);
        }

        const newStationsList = [...existingStationsList.map(station => { return { id: station.ID, value: station.VALUE } }),
            { value: newStationTitle, userFieldId: 970 }]; // for tests use 1243

        // id: 1243, // ID поля
        const updateResult = await (await fetch(`${bxLinkDecrypted}userfieldconfig.update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                moduleId: 'crm',
                id: 970,
                field: {
                    userTypeId: "enumeration",
                    enum: newStationsList
                }
            })
        })).json();

        return updateResult;

    } catch (error) {
        logMessage(LOG_TYPES.E, "updateProductStationListUserfield", error);
        return null;
    }
}

const updateDevicesWithNewStation = async (newStation) => {
    try {
        const bxLinkDecrypted = await decryptText(process.env.BX_LINK, process.env.CRYPTO_KEY, process.env.CRYPTO_IV);
        const plusTariffsIds = [1144, 1146, 1148, 1150, 1300, 1528, 1530, 1532, 1534, 1535];

        // Получение приборов
        const filterString = plusTariffsIds.map(id => `filter[ufCrm6_1730972653601][]=${encodeURIComponent(id)}`).join('&');
        const devicesResponse = await (await fetch(`${bxLinkDecrypted}crm.item.list?entityTypeId=177&${filterString}`)).json();
        const devicesWithTariffPlus = devicesResponse.result?.items || [];

        if (!devicesWithTariffPlus.length) {
            logMessage(LOG_TYPES.W, "updateDevicesWithNewStation", "No devices found for the specified tariffs.");
            return null;
        }

        // Формируем команды для батч-запроса
        const commands = {};
        devicesWithTariffPlus.forEach((device, index) => {
            const existingStationsList = device.ufCrm6_1730973093114 || [];
            // const existingStationsList = device.ufCrm6_1748266035070 || [];
            const newStationsList = [...existingStationsList, newStation.id];

            // Формируем строку параметров для crm.item.update
            // const params = `entityTypeId=177&id=${device.id}&fields[ufCrm6_1730973093114]=${encodeURIComponent(JSON.stringify(newStationsList))}`;
            const fieldParams = newStationsList.map(id => `fields[ufCrm6_1730973093114][]=${encodeURIComponent(id)}`).join('&');
            const params = `entityTypeId=177&id=${device.id}&${fieldParams}`;
            commands[`update_device_${device.id}`] = `crm.item.update?${params}`;
        });

        // Разбиваем команды на группы по 50 и выполняем батч-запрос
        const batchSize = 50;
        const allResults = [];
        const commandKeys = Object.keys(commands);

        for (let i = 0; i < commandKeys.length; i += batchSize) {
            const batchCommands = {};
            const batchKeys = commandKeys.slice(i, i + batchSize);
            batchKeys.forEach(key => {
                batchCommands[key] = commands[key];
            });

            // Формируем тело запроса в формате application/x-www-form-urlencoded
            const body = {};
            Object.keys(batchCommands).forEach(key => {
                body[`cmd[${key}]`] = batchCommands[key];
            });

            const url = `${bxLinkDecrypted}batch`;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(body).toString()
            });

            if (!response.ok) {
                throw new Error(`Batch request failed: ${response.statusText}`);
            }

            const data = await response.json();
            if (data.error) {
                throw new Error(`Batch request error: ${JSON.stringify(data.error)}`);
            }

            const batchResults = Object.values(data.result.result).map(item => {
                if (item.error) {
                    logMessage(LOG_TYPES.E, "updateDevicesWithNewStation", `Command failed: ${JSON.stringify(item.error)}`);
                    return null;
                }
                return item;
            }).filter(item => item !== null);

            allResults.push(...batchResults);
        }

        if (allResults.length > 0) {
            logMessage(LOG_TYPES.I, "updateDevicesWithNewStation", `Successfully updated ${allResults.length} devices with new station ID ${newStation.id}.`);
            return { allResults: allResults, devices: devicesWithTariffPlus };
        } else {
            throw new Error("No devices were updated.");
        }
    } catch (error) {
        logMessage(LOG_TYPES.E, "updateDevicesWithNewStation", `Error updating devices: ${error.message}`);
        return null;
    }
};

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
            throw new Error('Invalid input: serial and stations are required, and stations must be an array');
        }

        for (const station of stations) {
            if (!station.name || !station.formats || !Array.isArray(station.formats)) {
                throw new Error(`Invalid station data: ${JSON.stringify(station)}. Name and formats are required, and formats must be an array`);
            }
        }

        // Чтение и нормализация содержимого USERS.aut
        let usersContent = await sftp.get(usersAutPath).then(data => data.toString()).catch(() => '');
        let usersLines = usersContent.trim().split('\n').filter(line => line.trim());

        // Проверка на дубли
        if (usersLines.some(line => line.startsWith(`${finalLogin}:`))) {
            throw new Error(`Login ${finalLogin} already exists`);
        }

        // Добавляем новую строку
        usersLines.push(`${finalLogin}:${finalPassword}`);
        usersContent = usersLines.join('\n') + '\n';
        await sftp.put(Buffer.from(usersContent), usersAutPath);
        await logMessage(LOG_TYPES.I, 'manageDevice 56', `Added user ${finalLogin}:${finalPassword} to USERS.aut for serial ${serial}`);

        // Чтение и нормализация содержимого GROUPS.aut
        let groupsContent = await sftp.get(groupsAutPath).then(data => data.toString()).catch(() => '');
        let groupsLines = groupsContent.trim().split('\n').filter(line => line.trim());

        // Добавляем новую строку
        groupsLines.push(`${finalGroup}:${finalLogin}:1`);
        groupsContent = groupsLines.join('\n') + '\n';
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
                // Убедимся, что формат начинается с /
                const normalizedFormat = format.startsWith('/') ? format : `/${format}`;
                stationsMap.get(currentStation).set(normalizedFormat, groups.split(',').filter(g => g));
            }
        }

        // Обновление станций и форматов
        for (const station of stations) {
            const stationName = station.name;
            if (!stationsMap.has(stationName)) {
                stationsMap.set(stationName, new Map());
            }
            const formatsMap = stationsMap.get(stationName);
            for (let format of station.formats) {
                // Убедимся, что форматы переданы без / и :
                const cleanFormat = format.startsWith('/') ? format.slice(1) : format;
                const finalFormat = cleanFormat.endsWith(':') ? cleanFormat.slice(0, -1) : cleanFormat;
                // Добавляем / в начало
                const normalizedFormat = `/${finalFormat}`;
                const groups = formatsMap.get(normalizedFormat) || [];
                if (!groups.includes(finalGroup)) {
                    groups.push(finalGroup);
                }
                formatsMap.set(normalizedFormat, groups);
            }
        }

        // Формирование нового содержимого
        let updatedLines = [];
        for (const [station, formatsMap] of stationsMap) {
            if (formatsMap.size > 0) {
                updatedLines.push(`#${station}`);
                for (const [format, groups] of formatsMap) {
                    if (groups.length > 0) {
                        updatedLines.push(`${format}:${groups.join(',')}`);
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

app.post(BASE_URL + 'handle_new_station_creation', async (req, res) => {
    let stationId = req.query.stationId || req.query.params?.stationId || null;
    const sftp = new Client();

    try {
        if (!stationId) {
            throw new Error("Station ID not found");
        }
        typeof stationId === 'string' ? stationId = stationId.toLowerCase() : null;
        stationId.includes("tb1_") ? stationId = stationId.replace("tb1_", "") : null;

        const bxLinkDecrypted = await decryptText(process.env.BX_LINK, process.env.CRYPTO_KEY, process.env.CRYPTO_IV);
        await sftp.connect(sftpConfig);

        const station = await (await fetch(`${bxLinkDecrypted}/crm.item.get?entityTypeId=177&id=${Number(stationId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        })).json();
        const stationData = station.result.item;

        const deviceStationListUF = await updateProductStationListUserfield(stationData.title);

        if (!deviceStationListUF) {
            throw new Error("Error while adding new station in list. Possible reasons: \n1) Same station is already in list\n2) Server error");
        }

        const newStation = deviceStationListUF.result.field.enum.find(station =>
            station.value.toLowerCase().trim().replace(/[^\wа-яА-Я0-9]/g, "") ===
            stationData.title.toLowerCase().trim().replace(/[^\wа-яА-Я0-9]/g, "")
        );

        const updateIdFieldInStationCard = await (await fetch(
            `${bxLinkDecrypted}/crm.item.update?entityTypeId=177&id=${Number(stationId)}&fields[ufCrm6_1747752804167]=${newStation.id}`
        )).json();

        const clientmountField = stationData.ufCrm6_1747732721580; // Код станции (#ALM3)
        const formatCMRPField = stationData.ufCrm6_1747732525842; // Поправка (/ALM3CMRP)
        const formatCMRXField = stationData.ufCrm6_1747732550194; // Поправка (/ALM3CMRX)
        const formatRTCM31Field = stationData.ufCrm6_1747732575237; // Поправка (/ALM3RTCM31)
        const formatRTCM32Field = stationData.ufCrm6_1747732606707; // Поправка (/ALM3RTCM32)

        const result = await updateDevicesWithNewStation(newStation);
        const devices = result.devices;

        // Проверяем наличие кода станции
        if (!clientmountField || !clientmountField.startsWith('#')) {
            throw new Error('Invalid or missing clientmountField (ufCrm6_1747732721580)');
        }

        // Извлекаем все поправки отдельно
        const formats = [
            formatCMRPField,
            formatCMRXField,
            formatRTCM31Field,
            formatRTCM32Field
        ].filter(format => format); // Фильтруем пустые значения

        if (formats.length === 0) {
            throw new Error('No formats provided for station');
        }

        // Извлекаем группы из devices
        const groups = devices.map(device => ({
            group: device.ufCrm6_1740377767444 || '',
            login: device.ufCrm6_1730979706200 || '',
            password: device.ufCrm6_1730979718324 || ''
        })).filter(device => device.group); // Фильтруем устройства без группы

        if (groups.length === 0) {
            throw new Error('No devices with groups found');
        }

        // Формируем список групп
        const groupList = groups.map(g => g.group).join(',');

        // Чтение текущего содержимого clientmounts.aut
        const clientmountsPath = '/home/tmp/clientmounts.aut'; // Укажи правильный путь к файлу
        let clientmountsContent = await sftp.get(clientmountsPath).then(data => data.toString()).catch(() => '');
        let clientmountsLines = clientmountsContent.trim().split('\n').filter(line => line.trim());

        // Проверяем, есть ли уже такой код станции
        const codeExists = clientmountsLines.some(line => line === clientmountField);
        if (codeExists) {
            // Если код уже есть, добавляем только новые поправки
            const existingFormats = clientmountsLines
                .filter(line => line.startsWith('/'))
                .map(line => line.split(':')[0]);

            const newEntries = formats.map(format => `${format}:${groupList}`);
            const entriesToAdd = newEntries.filter(entry => {
                const format = entry.split(':')[0];
                return !existingFormats.includes(format);
            });

            if (entriesToAdd.length === 0) {
                console.log(`Code ${clientmountField} already exists with all formats in clientmounts.aut`);
            } else {
                const codeIndex = clientmountsLines.indexOf(clientmountField);
                clientmountsLines.splice(codeIndex + 1, 0, ...entriesToAdd); // Добавляем после кода
                clientmountsContent = clientmountsLines.join('\n') + '\n';
                await sftp.put(Buffer.from(clientmountsContent), clientmountsPath);
                console.log(`Added new formats for code ${clientmountField} to clientmounts.aut: ${entriesToAdd.join('\n')}`);
            }
        } else {
            // Если кода нет, добавляем его и все поправки
            const newEntries = formats.map(format => `${format}:${groupList}`);
            clientmountsLines.push(clientmountField, ...newEntries);
            clientmountsContent = clientmountsLines.join('\n') + '\n';
            await sftp.put(Buffer.from(clientmountsContent), clientmountsPath);
            console.log(`Added new code ${clientmountField} with formats to clientmounts.aut: ${newEntries.join('\n')}`);
        }

        res.send({
            stations: stationData,
            result: result,
        });
    } catch (error) {
        await logMessage(LOG_TYPES.E, 'handle_new_station_creation', error);
        res.status(500).json({ error: error.message });
    } finally {
        await sftp.end();
    }
});

app.post(BASE_URL + 'webhook_handle_station_edit', async (req, res) => {
    let deviceId = req.query.deviceId || req.query.params?.deviceId || null;
    const sftp = new Client();

    try {
        // Логируем входящий запрос
        if (!deviceId) {
            throw new Error("Device ID not found");
        }
        typeof deviceId === 'string' ? deviceId = deviceId.toLowerCase() : null;
        deviceId.includes("tb1_") ? deviceId = deviceId.replace("tb1_", "") : null;
        console.log('Device ID:', deviceId);

        const bxLinkDecrypted = await decryptText(process.env.BX_LINK, process.env.CRYPTO_KEY, process.env.CRYPTO_IV);
        await sftp.connect(sftpConfig);

        const device = await (await fetch(`${bxLinkDecrypted}/crm.item.get?entityTypeId=177&id=${deviceId}`)).json();
        if (device.error) {
            throw new Error(`${device.error_description}`);
        }
        const deviceData = device.result.item;

        const chosenStations = deviceData.ufCrm6_1730973093114;
        const login = deviceData.ufCrm6_1730979706200;
        const password = deviceData.ufCrm6_1730979718324;
        const group = deviceData.ufCrm6_1740377767444;

        if (!group) {
            throw new Error('Group (ufCrm6_1740377767444) not found for device');
        }

        console.log('Chosen stations count:', chosenStations.length);

        // Получаем все станции с пагинацией
        const filterString = chosenStations.map(station => `filter[ufCrm6_1747752804167][]=${encodeURIComponent(station)}`).join('&');
        let allStations = [];
        let start = 0;
        let total = 0;

        do {
            const url = `${bxLinkDecrypted}/crm.item.list?entityTypeId=177&${filterString}&start=${start}`;
            const response = await fetch(url);
            const stationsList = await response.json();

            if (stationsList.error) {
                throw new Error(`${stationsList.error}`);
            }

            const items = stationsList.result.items || [];
            allStations = allStations.concat(items);
            total = stationsList.total || 0;
            start += 50; // Bitrix24 возвращает максимум 50 записей за раз
            console.log(`Fetched ${items.length} stations, total: ${total}, start: ${start}`);
        } while (start < total);

        console.log('Total stations fetched:', allStations.length);

        const stationsListData = allStations.map(item => {
            // Нормализуем форматы: добавляем / в начало, если его нет, и убираем : в конце
            const normalizeFormat = (format) => {
                if (!format || typeof format !== 'string') return null;
                format = format.trim();
                if (format.endsWith(':')) format = format.slice(0, -1);
                return format.startsWith('/') ? format : `/${format}`;
            };

            return {
                id: item.id,
                title: item.title,
                ufCrm6_1747732525842: normalizeFormat(item.ufCrm6_1747732525842), // /popravka
                ufCrm6_1747732550194: normalizeFormat(item.ufCrm6_1747732550194), // /popravka
                ufCrm6_1747732575237: normalizeFormat(item.ufCrm6_1747732575237), // /popravka
                ufCrm6_1747732606707: normalizeFormat(item.ufCrm6_1747732606707), // /popravka
                ufCrm6_1747732721580: item.ufCrm6_1747732721580  // #Name
            };
        }).filter(station => {
            // Пропускаем станции, у которых нет ни одного корректного формата
            const formats = [
                station.ufCrm6_1747732525842,
                station.ufCrm6_1747732550194,
                station.ufCrm6_1747732575237,
                station.ufCrm6_1747732606707
            ].filter(format => format);
            return formats.length > 0;
        });

        // console.log('Stations list data:', stationsListData);

        // Извлекаем коды станций из stationsListData
        const activeStationCodes = stationsListData
            .map(station => station.ufCrm6_1747732721580)
            .filter(code => code && code.startsWith('#'));

        // Чтение текущего содержимого clientmounts.aut
        const clientmountsPath = '/home/tmp/clientmounts.aut';
        let clientmountsContent = await sftp.get(clientmountsPath).then(data => data.toString()).catch(() => '');
        let clientmountsLines = clientmountsContent.trim().split('\n').filter(line => line.trim());

        // 1. Добавляем или обновляем записи для станций из stationsListData
        for (const station of stationsListData) {
            const clientmountField = station.ufCrm6_1747732721580; // Код станции (#Aktau)
            if (!clientmountField || !clientmountField.startsWith('#')) {
                console.warn(`Invalid or missing clientmountField for station ${station.id}, skipping...`);
                continue;
            }

            // Извлекаем все поправки отдельно
            const formats = [
                station.ufCrm6_1747732525842,
                station.ufCrm6_1747732550194,
                station.ufCrm6_1747732575237,
                station.ufCrm6_1747732606707
            ].filter(format => format); // Фильтруем пустые значения

            if (formats.length === 0) {
                console.warn(`No formats provided for station ${station.id}, skipping...`);
                continue;
            }

            // Проверяем, есть ли уже такой код станции
            const codeExists = clientmountsLines.some(line => line === clientmountField);
            if (codeExists) {
                // Если код уже есть, обновляем существующие поправки или добавляем новые
                const codeIndex = clientmountsLines.indexOf(clientmountField);
                const endOfBlockIndex = clientmountsLines.slice(codeIndex + 1).findIndex(line => line.startsWith('#'));
                const blockEnd = endOfBlockIndex === -1 ? clientmountsLines.length : codeIndex + 1 + endOfBlockIndex;
                const stationBlock = clientmountsLines.slice(codeIndex, blockEnd);

                const existingFormats = stationBlock
                    .filter(line => line.startsWith('/'))
                    .map(line => line.split(':')[0]);

                let updatedLines = [...clientmountsLines.slice(0, codeIndex)];
                updatedLines.push(clientmountField); // Добавляем код станции

                for (const format of formats) {
                    const existingFormatLine = stationBlock.find(line => line.startsWith(format));
                    if (existingFormatLine) {
                        // Если поправка уже существует, добавляем новую группу, исключая дубликаты
                        const existingGroups = existingFormatLine.split(':')[1] ? existingFormatLine.split(':')[1].split(',') : [];
                        const allGroups = [...new Set([...existingGroups, group])]; // Исключаем дубликаты
                        updatedLines.push(`${format}:${allGroups.join(',')}`);
                    } else {
                        // Если поправки нет, добавляем новую запись
                        updatedLines.push(`${format}:${group}`);
                    }
                }

                updatedLines.push(...clientmountsLines.slice(blockEnd));
                clientmountsLines = updatedLines;
            } else {
                // Если кода нет, добавляем его и все поправки
                const newEntries = formats.map(format => `${format}:${group}`);
                clientmountsLines.push(clientmountField, ...newEntries);
            }
        }

        // 2. Удаляем группы из станций, которых больше нет в stationsListData
        let updatedLines = [];
        let currentCode = null;
        let currentBlock = [];

        for (let i = 0; i < clientmountsLines.length; i++) {
            const line = clientmountsLines[i];

            if (line.startsWith('#')) {
                // Если у нас есть предыдущий блок, обрабатываем его
                if (currentCode) {
                    if (activeStationCodes.includes(currentCode)) {
                        // Если станция всё ещё активна, сохраняем её
                        updatedLines.push(currentCode);
                        updatedLines.push(...currentBlock);
                    } else {
                        // Если станции больше нет, удаляем группу текущего прибора
                        let updatedBlock = [];
                        for (const formatLine of currentBlock) {
                            const [format, groups] = formatLine.split(':');
                            let groupList = groups ? groups.split(',') : [];
                            groupList = groupList.filter(g => g !== group); // Удаляем группу прибора
                            if (groupList.length > 0) {
                                updatedBlock.push(`${format}:${groupList.join(',')}`);
                            }
                        }
                        // Если после удаления группы остались записи, сохраняем станцию
                        if (updatedBlock.length > 0) {
                            updatedLines.push(currentCode);
                            updatedLines.push(...updatedBlock);
                        }
                    }
                }
                // Начинаем новый блок
                currentCode = line;
                currentBlock = [];
            } else if (currentCode) {
                currentBlock.push(line);
            }
        }

        // Обрабатываем последний блок
        if (currentCode) {
            if (activeStationCodes.includes(currentCode)) {
                updatedLines.push(currentCode);
                updatedLines.push(...currentBlock);
            } else {
                let updatedBlock = [];
                for (const formatLine of currentBlock) {
                    const [format, groups] = formatLine.split(':');
                    let groupList = groups ? groups.split(',') : [];
                    groupList = groupList.filter(g => g !== group); // Удаляем группу прибора
                    if (groupList.length > 0) {
                        updatedBlock.push(`${format}:${groupList.join(',')}`);
                    }
                }
                if (updatedBlock.length > 0) {
                    updatedLines.push(currentCode);
                    updatedLines.push(...updatedBlock);
                }
            }
        }

        clientmountsLines = updatedLines;
        clientmountsContent = clientmountsLines.join('\n') + '\n';
        await sftp.put(Buffer.from(clientmountsContent), clientmountsPath);
        console.log(`Updated clientmounts.aut: removed group ${group} from stations not in stationsListData`);

        res.status(200).send('Webhook processed successfully');
    } catch (error) {
        await logMessage(LOG_TYPES.E, 'webhook_handle_station_edit', error);
        res.status(500).json({ error: error.message });
    } finally {
        await sftp.end();
    }
});

app.post(BASE_URL + "init/", async (req, res) => {
    try {
        const bxLink = req.body.bx_link;
        if (!bxLink) {
            res.status(400).json({
                "status": false,
                "status_msg": "error",
                "message": "Необходимо предоставить ссылку входящего вебхука!"
            });
            return;
        }

        const keyIv = generateCryptoKeyAndIV();
        const bxLinkEncrypted = await encryptText(bxLink, keyIv.CRYPTO_KEY, keyIv.CRYPTO_IV);

        const bxLinkEncryptedBase64 = Buffer.from(bxLinkEncrypted, 'hex').toString('base64');

        const envPath = path.resolve(process.cwd(), '.env');
        const envContent = `CRYPTO_KEY=${keyIv.CRYPTO_KEY}\nCRYPTO_IV=${keyIv.CRYPTO_IV}\nBX_LINK=${bxLinkEncryptedBase64}\n`;

        fs.writeFileSync(envPath, envContent, 'utf8');

        res.status(200).json({
            "status": true,
            "status_msg": "success",
            "message": "Система готова работать с вашим битриксом!",
        });
    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "/init", error);
        res.status(500).json({
            "status": false,
            "status_msg": "error",
            "message": "Server error"
        });
    }
});

app.listen(3456, async () => {
    console.log('Server running on port 3456');
    await logMessage(LOG_TYPES.I, 'STARTUP', 'Server started on port 1234');
});