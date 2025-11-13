const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const puppeteer = require('puppeteer');
const fs = require('fs');

// ========== CONFIGURACIÓN ==========
const CONFIG = {
    telegramToken: '8508871696:AAHVgoFh-vecqUZ_wcpplSy2pcQjMMs7cJg', // ⚠️ Obtener de @BotFather
    chatId: '6569332546', // ⚠️ ID del grupo o chat
    microsoftEmail: 'jakob.ponce@unach.edu.ec',
    microsoftPass: 'Sebas2104',
    moodleUrl: 'https://moodle.unach.edu.ec',
};

// ========== INICIALIZACIÓN ==========
const bot = new TelegramBot(CONFIG.telegramToken, { polling: true });

const DB_FILE = './tareas_moodle.json';
let tareasActuales = [];
let ultimaActualizacion = null;

// ========== BASE DE DATOS ==========
function cargarTareas() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            tareasActuales = data.tareas || [];
            ultimaActualizacion = data.ultimaActualizacion || null;
            console.log(`✅ Tareas cargadas: ${tareasActuales.length}`);
        }
    } catch (error) {
        console.error('Error al cargar tareas:', error);
        tareasActuales = [];
    }
}

function guardarTareas(tareas) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify({
            tareas,
            ultimaActualizacion: new Date().toISOString()
        }, null, 2));
    } catch (error) {
        console.error('Error al guardar tareas:', error);
    }
}

// ========== SCRAPER DE MOODLE ==========
async function obtenerTareasDeMoodle() {
    const inicioTiempo = Date.now();
    console.log('⚡ Extrayendo tareas desde Moodle...');

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // ========== LOGIN CON MICROSOFT ==========
        console.log('🔑 Iniciando sesión...');
        await page.goto(CONFIG.moodleUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        try {
            await page.waitForSelector('#login-identityprovider-btn-wrapper, .login-identityproviders, a[href*="oauth2"]', { timeout: 10000 });
            const microsoftButton = await page.$('#login-identityprovider-btn-wrapper a') ||
                await page.$('.login-identityproviders a') ||
                await page.$('a[href*="oauth2"]');

            if (microsoftButton) {
                await Promise.all([
                    microsoftButton.click(),
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
                ]);
            }
        } catch {
            await page.goto(CONFIG.moodleUrl + '/auth/oauth2/login.php?id=1', {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        // Ingresar email
        await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 10000 });
        await page.type('input[type="email"], input[name="loginfmt"]', CONFIG.microsoftEmail, { delay: 100 });

        const nextButton = await page.$('input[type="submit"]') || await page.$('button[type="submit"]');
        if (nextButton) {
            await Promise.all([
                nextButton.click(),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { })
            ]);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        // Ingresar contraseña
        await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 10000 });
        await page.type('input[type="password"], input[name="passwd"]', CONFIG.microsoftPass, { delay: 100 });

        const signInButton = await page.$('input[type="submit"]') || await page.$('button[type="submit"]');
        if (signInButton) {
            await Promise.all([
                signInButton.click(),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { })
            ]);
        }

        await new Promise(resolve => setTimeout(resolve, 3000));

        // Confirmar sesión si es necesario
        try {
            const staySignedInButton = await page.$('input[value="Yes"]') ||
                await page.$('input[type="submit"][value="Sí"]');

            if (staySignedInButton) {
                await Promise.all([
                    staySignedInButton.click(),
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { })
                ]);
            }
        } catch { }

        await new Promise(resolve => setTimeout(resolve, 2000));

        if (!page.url().includes('moodle.unach.edu.ec')) {
            throw new Error('No se pudo completar el login. Verifica tus credenciales.');
        }

        console.log('✅ Login exitoso');

        // ========== IR A /MY/ Y EXTRAER LÍNEA DE TIEMPO ==========
        console.log('📍 Cargando línea de tiempo...');
        await page.goto(CONFIG.moodleUrl + '/my/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 2000));

        // ========== EXTRAER TAREAS ==========
        const tareas = await page.evaluate(() => {
            const resultados = [];
            const lineaTiempo = document.querySelector('[data-region="timeline"]');

            if (!lineaTiempo) {
                return resultados;
            }

            const gruposFecha = lineaTiempo.querySelectorAll('.edw-timeline-event-list-item');

            gruposFecha.forEach((grupo) => {
                try {
                    const dateElement = grupo.querySelector('[data-region="event-list-content-date"][data-timestamp]');
                    let fechaGrupoISO = null;

                    if (dateElement) {
                        const timestamp = dateElement.getAttribute('data-timestamp');
                        if (timestamp) {
                            fechaGrupoISO = new Date(parseInt(timestamp) * 1000).toISOString();
                        }
                    }

                    const eventos = grupo.querySelectorAll('[data-region="event-list-item"]');

                    eventos.forEach((evento) => {
                        try {
                            let nombre = '';
                            const linkTarea = evento.querySelector('a[href*="/mod/"]');
                            if (linkTarea) {
                                nombre = linkTarea.textContent.trim();
                            }

                            nombre = nombre
                                .replace(/^Vencimiento de\s*/i, '')
                                .replace(/\s+vence$/i, '')
                                .trim();

                            let materia = 'Sin materia';
                            const materiaElement = evento.querySelector('.coursename-action .h-regular-6, .coursename-action span');
                            if (materiaElement) {
                                materia = materiaElement.textContent.trim();
                            }

                            let horaTexto = '';
                            const horaElement = evento.querySelector('.small-info-text, small');
                            if (horaElement) {
                                horaTexto = horaElement.textContent.trim();
                            }

                            const url = linkTarea ? linkTarea.href : '';

                            let fechaISO = null;
                            let fecha = 'Sin fecha';
                            let hora = 'Sin hora';
                            let tiempoRestante = 'Fecha no disponible';
                            let diasRestantes = 999;
                            let estado = 'Pendiente';

                            if (fechaGrupoISO && horaTexto) {
                                const matchHora = horaTexto.match(/(\d{1,2}):(\d{2})/);
                                if (matchHora) {
                                    const horaNum = parseInt(matchHora[1]);
                                    const minutoNum = parseInt(matchHora[2]);

                                    const fechaBase = new Date(fechaGrupoISO);
                                    fechaBase.setHours(horaNum, minutoNum, 0, 0);
                                    fechaISO = fechaBase.toISOString();

                                    fecha = fechaBase.toLocaleDateString('es-EC', {
                                        day: 'numeric',
                                        month: 'long',
                                        year: 'numeric'
                                    });
                                    hora = fechaBase.toLocaleTimeString('es-EC', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: false
                                    });

                                    const ahora = new Date();
                                    const diferencia = fechaBase - ahora;

                                    diasRestantes = Math.floor(diferencia / (1000 * 60 * 60 * 24));
                                    const horas = Math.floor((diferencia % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                                    const minutos = Math.floor((diferencia % (1000 * 60 * 60)) / (1000 * 60));

                                    const badgeAtrasado = evento.querySelector('.badge-danger');
                                    const esAtrasado = badgeAtrasado || diferencia < 0;

                                    if (esAtrasado) {
                                        const diasAtrasado = Math.abs(diasRestantes);
                                        const horasAtrasado = Math.abs(horas);
                                        if (diasAtrasado === 0) {
                                            tiempoRestante = horasAtrasado === 0 ? 'Vencido hace menos de 1h' : `Vencido hace ${horasAtrasado}h`;
                                        } else {
                                            tiempoRestante = `Vencido hace ${diasAtrasado}d`;
                                        }
                                        estado = 'Vencido';
                                    } else if (diasRestantes === 0) {
                                        tiempoRestante = horas === 0 ? `Vence en ${minutos}min` : `Vence HOY (${horas}h ${minutos}min)`;
                                        estado = 'Urgente';
                                    } else if (diasRestantes === 1) {
                                        tiempoRestante = `Vence MAÑANA (${horas}h)`;
                                        estado = 'Urgente';
                                    } else if (diasRestantes <= 3) {
                                        tiempoRestante = `${diasRestantes}d ${horas}h`;
                                        estado = 'Próximo';
                                    } else if (diasRestantes <= 7) {
                                        tiempoRestante = `${diasRestantes} días`;
                                        estado = 'Esta semana';
                                    } else {
                                        tiempoRestante = `${diasRestantes} días`;
                                        estado = 'Pendiente';
                                    }
                                }
                            }

                            if (nombre && nombre.length > 3) {
                                resultados.push({
                                    materia,
                                    nombre,
                                    fecha,
                                    hora,
                                    fechaISO,
                                    tiempoRestante,
                                    diasRestantes,
                                    estado,
                                    url
                                });
                            }

                        } catch (err) {
                            console.error(`❌ Error en evento:`, err);
                        }
                    });

                } catch (err) {
                    console.error(`❌ Error en grupo:`, err);
                }
            });

            return resultados;
        });

        await browser.close();

        const tiempoTotal = ((Date.now() - inicioTiempo) / 1000).toFixed(1);
        console.log(`⚡ COMPLETADO en ${tiempoTotal}s`);
        console.log(`✅ ${tareas.length} tareas encontradas`);

        return tareas;

    } catch (error) {
        await browser.close();
        throw error;
    }
}

// ========== ACTUALIZAR TAREAS ==========
async function actualizarTareas() {
    try {
        console.log('\n🔄 Actualizando tareas...');
        const tareasNuevas = await obtenerTareasDeMoodle();

        if (tareasNuevas.length === 0) {
            console.log('ℹ️ No hay tareas');
            return { nuevas: 0, total: 0, tareasNuevas: [] };
        }

        const tareasAgregadas = [];
        tareasNuevas.forEach(tarea => {
            const existe = tareasActuales.find(t =>
                t.nombre === tarea.nombre && t.materia === tarea.materia
            );
            if (!existe) {
                tareasAgregadas.push(tarea);
            }
        });

        tareasActuales = tareasNuevas;
        guardarTareas(tareasActuales);
        ultimaActualizacion = new Date();

        console.log(`✅ ${tareasAgregadas.length} nuevas, ${tareasNuevas.length} total`);

        return {
            nuevas: tareasAgregadas.length,
            total: tareasNuevas.length,
            tareasNuevas: tareasAgregadas
        };

    } catch (error) {
        console.error('❌ Error:', error.message);
        throw error;
    }
}

// ========== FORMATEAR MENSAJES ==========
function formatearMensajeTareas(tareas) {
    if (tareas.length === 0) {
        return '✅ <b>¡Todo al día!</b>\n\nNo tienes deberes pendientes por ahora 🎉';
    }

    const vencidos = tareas.filter(t => t.estado === 'Vencido');
    const urgentes = tareas.filter(t => t.estado === 'Urgente');
    const proximos = tareas.filter(t => t.estado === 'Próximo' || t.estado === 'Esta semana');
    const pendientes = tareas.filter(t => t.estado === 'Pendiente');

    let mensaje = '📚 <b>TUS DEBERES</b>\n\n';

    const proximosTotal = [...urgentes, ...proximos, ...pendientes];

    if (proximosTotal.length > 0) {
        mensaje += `📝 <b>Próximos deberes a entregar:</b>\n\n`;

        proximosTotal.forEach(t => {
            let emoji = '';
            let textoTiempo = '';

            if (t.estado === 'Urgente') {
                emoji = '🔥';
                if (t.diasRestantes === 0) {
                    textoTiempo = `Tienes que entregar <b>HOY</b> hasta las ${t.hora}`;
                } else if (t.diasRestantes === 1) {
                    textoTiempo = `Tienes que entregar <b>MAÑANA</b> hasta las ${t.hora}`;
                }
            } else if (t.estado === 'Próximo') {
                emoji = '⚠️';
                textoTiempo = `Tienes que entregar hasta el <b>${t.fecha}</b> a las ${t.hora}`;
            } else if (t.estado === 'Esta semana') {
                emoji = '📌';
                textoTiempo = `Tienes que entregar hasta el <b>${t.fecha}</b> a las ${t.hora}`;
            } else {
                emoji = '📋';
                textoTiempo = `Tienes que entregar hasta el <b>${t.fecha}</b> a las ${t.hora}`;
            }

            mensaje += `${emoji} <b>${t.nombre}</b>\n`;
            mensaje += `   Materia: ${t.materia}\n`;
            mensaje += `   ${textoTiempo}\n`;
            mensaje += `   <a href="${t.url}">Ver en Moodle</a>\n\n`;
        });
    }

    if (vencidos.length > 0) {
        mensaje += `━━━━━━━━━━━━━━━━━\n\n`;
        mensaje += `❌ <b>Deberes vencidos (${vencidos.length}):</b>\n\n`;

        vencidos.forEach(t => {
            mensaje += `⏰ <b>${t.nombre}</b>\n`;
            mensaje += `   Materia: ${t.materia}\n`;
            mensaje += `   ${t.tiempoRestante}\n`;
            mensaje += `   <a href="${t.url}">Ver en Moodle</a>\n\n`;
        });
    }

    mensaje += `━━━━━━━━━━━━━━━━━\n`;
    mensaje += `📊 Total de deberes: ${tareas.length}\n`;
    mensaje += `✅ Próximos: ${proximosTotal.length} | ❌ Vencidos: ${vencidos.length}`;

    return mensaje;
}

function formatearMensajeNuevas(tareasNuevas) {
    let mensaje = '🆕 <b>¡Tienes nuevos deberes!</b>\n\n';

    const urgentes = tareasNuevas.filter(t => t.estado === 'Urgente');
    const proximas = tareasNuevas.filter(t => t.estado === 'Próximo' || t.estado === 'Esta semana' || t.estado === 'Pendiente');
    const vencidas = tareasNuevas.filter(t => t.estado === 'Vencido');

    [...urgentes, ...proximas].forEach(t => {
        let emoji = t.estado === 'Urgente' ? '🔥' : '📌';
        let textoTiempo = '';

        if (t.diasRestantes === 0) {
            textoTiempo = `Tienes que entregar <b>HOY</b> hasta las ${t.hora}`;
        } else if (t.diasRestantes === 1) {
            textoTiempo = `Tienes que entregar <b>MAÑANA</b> hasta las ${t.hora}`;
        } else {
            textoTiempo = `Tienes que entregar hasta el <b>${t.fecha}</b> a las ${t.hora}`;
        }

        mensaje += `${emoji} <b>${t.nombre}</b>\n`;
        mensaje += `   Materia: ${t.materia}\n`;
        mensaje += `   ${textoTiempo}\n`;
        mensaje += `   <a href="${t.url}">Ver en Moodle</a>\n\n`;
    });

    if (vencidas.length > 0) {
        vencidas.forEach(t => {
            mensaje += `❌ <b>${t.nombre}</b>\n`;
            mensaje += `   Materia: ${t.materia}\n`;
            mensaje += `   Ya estaba vencido: ${t.tiempoRestante}\n`;
            mensaje += `   <a href="${t.url}">Ver en Moodle</a>\n\n`;
        });
    }

    return mensaje;
}

// ========== COMANDOS DE TELEGRAM ==========
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        `🤖 <b>Bot Moodle UNACH</b>\n\n` +
        `Comandos disponibles:\n` +
        `/tareas - Ver tus deberes\n` +
        `/actualizar - Actualizar ahora\n` +
        `/ayuda - Ayuda\n\n` +
        `<b>Chat ID:</b> <code>${chatId}</code>\n` +
        `Copia este ID y ponlo en CONFIG.chatId`,
        { parse_mode: 'HTML' }
    );
});

bot.onText(/\/tareas/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, formatearMensajeTareas(tareasActuales), {
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
});

bot.onText(/\/actualizar/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '🔄 Actualizando...');

    try {
        await actualizarTareas();
        await bot.sendMessage(chatId, formatearMensajeTareas(tareasActuales), {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

bot.onText(/\/ayuda/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        `🤖 <b>COMANDOS</b>\n\n` +
        `/tareas - Ver tus deberes\n` +
        `/actualizar - Actualizar ahora\n` +
        `/ayuda - Esta ayuda`,
        { parse_mode: 'HTML' }
    );
});

// ========== PROGRAMACIÓN ==========
function programarActualizaciones() {
    schedule.scheduleJob('*/15 * * * *', async () => {
        console.log('\n⏰ Actualización automática...');
        try {
            const resultado = await actualizarTareas();

            if (resultado.nuevas > 0) {
                await bot.sendMessage(CONFIG.chatId, formatearMensajeNuevas(resultado.tareasNuevas), {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                console.log('✅ Notificación enviada');
            }
        } catch (error) {
            console.error('Error:', error.message);
        }
    });

    console.log('✅ Actualizaciones cada 15min');
}

function programarRecordatorios() {
    schedule.scheduleJob('0 8 * * *', async () => {
        console.log('🔔 Recordatorio matutino...');

        try {
            const vencidos = tareasActuales.filter(t => t.estado === 'Vencido');
            const urgentes = tareasActuales.filter(t => t.estado === 'Urgente');
            const proximos = tareasActuales.filter(t => t.estado === 'Próximo');

            if (vencidos.length > 0 || urgentes.length > 0 || proximos.length > 0) {
                let mensaje = '☀️ <b>Buenos días!</b>\n\n';
                mensaje += '📌 Recordatorio de tus deberes:\n\n';

                if (urgentes.length > 0) {
                    mensaje += `🔥 <b>Tienes ${urgentes.length} deber(es) urgente(s):</b>\n`;
                    urgentes.slice(0, 3).forEach(t => {
                        if (t.diasRestantes === 0) {
                            mensaje += `• ${t.nombre}\n  Tienes que entregar <b>HOY</b> hasta las ${t.hora}\n`;
                        } else if (t.diasRestantes === 1) {
                            mensaje += `• ${t.nombre}\n  Tienes que entregar <b>MAÑANA</b> hasta las ${t.hora}\n`;
                        }
                    });
                    mensaje += '\n';
                }

                if (proximos.length > 0) {
                    mensaje += `📋 Próximos ${proximos.length} deber(es) esta semana\n\n`;
                }

                if (vencidos.length > 0) {
                    mensaje += `❌ Tienes ${vencidos.length} deber(es) vencido(s)\n\n`;
                }

                mensaje += 'Escribe /tareas para ver todos los detalles';

                await bot.sendMessage(CONFIG.chatId, mensaje, { parse_mode: 'HTML' });
                console.log('✅ Recordatorio enviado');
            }
        } catch (error) {
            console.error('Error:', error);
        }
    });

    console.log('✅ Recordatorios 8 AM');
}

// ========== INICIAR ==========
console.log('🚀 Iniciando bot de Telegram...');
cargarTareas();

setTimeout(async () => {
    try {
        await actualizarTareas();

        if (CONFIG.chatId !== 'TU_CHAT_ID') {
            await bot.sendMessage(CONFIG.chatId, formatearMensajeTareas(tareasActuales), {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
            console.log('✅ Mensaje inicial enviado');
        }
    } catch (error) {
        console.error('⚠️ Error:', error.message);
    }

    programarActualizaciones();
    programarRecordatorios();
}, 3000);

console.log('✅ Bot iniciado correctamente');