// src/models/cash.model.js
const moment = require('moment');
let dbConnection;

const init = (connection) => {
    dbConnection = connection;
};

// --- CRUD DE BASE POUR TRANSACTIONS ---
const create = async (transactionData) => {
    const { user_id, type, category_id, amount, comment } = transactionData;
    const createdAt = transactionData.created_at || moment().format('YYYY-MM-DD HH:mm:ss');
    const query = `
        INSERT INTO cash_transactions (user_id, type, category_id, amount, comment, status, created_at, validated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const status = type === 'remittance' ? 'pending' : 'confirmed';
    const validatedBy = type === 'remittance' ? null : user_id;
    const [result] = await dbConnection.execute(query, [user_id, type, category_id, amount, comment, status, createdAt, validatedBy]);
    return result.insertId;
};

const update = async (id, data) => {
    const query = 'UPDATE cash_transactions SET amount = ?, comment = ? WHERE id = ?';
    const [result] = await dbConnection.execute(query, [data.amount, data.comment, id]);
    return result;
};

const remove = async (id) => {
    const query = 'DELETE FROM cash_transactions WHERE id = ?';
    const [result] = await dbConnection.execute(query, [id]);
    return result;
};

const findAll = async (filters) => {
    let query = `
        SELECT ct.*, u.name as user_name, ec.name as category_name, val.name as validated_by_name
        FROM cash_transactions ct
        LEFT JOIN users u ON ct.user_id = u.id
        LEFT JOIN users val ON ct.validated_by = val.id
        LEFT JOIN expense_categories ec ON ct.category_id = ec.id
        WHERE 1=1 `;
    const params = [];
    if (filters.type) {
        query += ' AND ct.type = ?';
        params.push(filters.type);
    }
    if (filters.startDate && filters.endDate) {
        query += ' AND DATE(ct.created_at) BETWEEN ? AND ?';
        params.push(filters.startDate, filters.endDate);
    }
    if (filters.search) {
        query += ' AND (u.name LIKE ? OR ct.comment LIKE ? OR ec.name LIKE ?)';
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm, searchTerm);
    }
    query += ' ORDER BY ct.created_at DESC';
    const [rows] = await dbConnection.execute(query, params);
    return rows;
};

const getExpenseCategories = async () => {
    const [rows] = await dbConnection.execute('SELECT * FROM expense_categories ORDER BY name ASC');
    return rows;
};

// --- LOGIQUE SPÉCIFIQUE AUX VERSEMENTS ---

const findRemittanceSummary = async (startDate, endDate, search) => {
    let query = `
        SELECT 
            u.id as user_id, u.name as user_name, 
            SUM(CASE WHEN ct.status = 'pending' THEN 1 ELSE 0 END) as pending_count, 
            COALESCE(SUM(CASE WHEN ct.status = 'pending' THEN ct.amount ELSE 0 END), 0) as pending_amount,
            SUM(CASE WHEN ct.status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_count,
            COALESCE(SUM(CASE WHEN ct.status = 'confirmed' THEN ct.amount ELSE 0 END), 0) as confirmed_amount
        FROM users u
        LEFT JOIN cash_transactions ct ON u.id = ct.user_id 
            AND ct.type = 'remittance' 
            AND DATE(ct.created_at) BETWEEN ? AND ?
        WHERE u.role = 'livreur'
    `;
    const params = [startDate, endDate];
    if (search) {
        query += ' AND u.name LIKE ?';
        params.push(`%${search}%`);
    }
    query += ` GROUP BY u.id, u.name HAVING pending_count > 0 OR confirmed_count > 0 ORDER BY u.name ASC`;
    const [rows] = await dbConnection.execute(query, params);
    return rows;
};

const findRemittanceDetails = async (deliverymanId, startDate, endDate) => {
    let query = `
        SELECT 
            ct.*, o.id as order_id, o.delivery_location, s.name as shop_name,
            GROUP_CONCAT(oi.item_name SEPARATOR ', ') as item_names
        FROM cash_transactions ct
        LEFT JOIN orders o ON ct.comment LIKE CONCAT('%', o.id) 
        LEFT JOIN shops s ON o.shop_id = s.id
        LEFT JOIN order_items oi ON o.id = oi.order_id
        WHERE ct.user_id = ? AND ct.type = 'remittance'
    `;
    const params = [deliverymanId];
    if (startDate && endDate) {
        query += ' AND DATE(ct.created_at) BETWEEN ? AND ?';
        params.push(startDate, endDate);
    }
    query += ` GROUP BY ct.id ORDER BY ct.status ASC, ct.created_at DESC`;
    const [rows] = await dbConnection.execute(query, params);
    return rows;
};

const updateRemittanceAmount = async (transactionId, newAmount) => {
    const query = 'UPDATE cash_transactions SET amount = ? WHERE id = ? AND status = "pending"';
    const [result] = await dbConnection.execute(query, [newAmount, transactionId]);
    return result;
};

const confirmRemittance = async (transactionIds, paidAmount, validatedBy) => {
    const connection = await dbConnection.getConnection();
    try {
        await connection.beginTransaction();
        const placeholders = transactionIds.map(() => '?').join(',');
        const [transactions] = await connection.execute(`SELECT * FROM cash_transactions WHERE id IN (${placeholders}) AND status = 'pending'`, transactionIds);
        
        if (transactions.length === 0) throw new Error("Aucune transaction en attente sélectionnée.");
        const deliverymanId = transactions[0].user_id;
        const expectedAmount = transactions.reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
        const difference = expectedAmount - paidAmount;

        await connection.execute(`UPDATE cash_transactions SET status = 'confirmed', validated_by = ?, validated_at = NOW() WHERE id IN (${placeholders})`, [validatedBy, ...transactionIds]);

        if (difference > 0) {
            await connection.execute(`INSERT INTO deliveryman_shortfalls (deliveryman_id, amount, comment, created_by_user_id) VALUES (?, ?, ?, ?)`, [deliverymanId, difference, `Manquant sur versement(s) ID: ${transactionIds.join(', ')}`, validatedBy]);
        }
        await connection.commit();
        return { success: true, expected: expectedAmount, paid: paidAmount, shortfall: difference };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

const findShortfalls = async (filters = {}) => {
    let query = `
        SELECT ds.*, u.name as deliveryman_name
        FROM deliveryman_shortfalls ds
        JOIN users u ON ds.deliveryman_id = u.id
        WHERE 1=1
    `;
    const params = [];
    if (filters.status) {
        query += ' AND ds.status = ?';
        params.push(filters.status);
    }
    if (filters.search) {
        query += ' AND u.name LIKE ?';
        params.push(`%${filters.search}%`);
    }
    query += ' ORDER BY ds.created_at DESC';
    const [rows] = await dbConnection.execute(query, params);
    return rows;
};

const settleShortfall = async (shortfallId, amount, userId) => {
    const connection = await dbConnection.getConnection();
    try {
        await connection.beginTransaction();

        const [existingShortfall] = await connection.execute('SELECT * FROM deliveryman_shortfalls WHERE id = ?', [shortfallId]);
        if (!existingShortfall || existingShortfall.length === 0) throw new Error("Manquant non trouvé.");

        const shortfall = existingShortfall[0];
        const remainingAmount = parseFloat(shortfall.amount) - parseFloat(amount);

        if (remainingAmount <= 0) {
            // Entièrement réglé
            await connection.execute('UPDATE deliveryman_shortfalls SET amount = ?, status = "paid", settled_at = NOW() WHERE id = ?', [0, shortfallId]);
        } else {
            // Partiellement réglé
            await connection.execute('UPDATE deliveryman_shortfalls SET amount = ?, status = "partially_paid" WHERE id = ?', [remainingAmount, shortfallId]);
        }

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};


const performCashClosing = async (closingDate, actualCash, comment, userId) => {
    const connection = await dbConnection.getConnection();
    try {
        await connection.beginTransaction();

        // Étape 1: Récupérer les métriques de la journée à clôturer
        const [metricsRows] = await connection.execute(`
            SELECT
                COALESCE(SUM(CASE WHEN type = 'remittance' AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS total_remitted,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END), 0) AS total_expenses,
                COALESCE(SUM(CASE WHEN type = 'manual_withdrawal' THEN ABS(amount) ELSE 0 END), 0) AS total_withdrawals
            FROM cash_transactions
            WHERE ( (type = 'remittance' AND status = 'confirmed' AND DATE(validated_at) = ?) OR 
                    (type IN ('expense', 'manual_withdrawal') AND DATE(created_at) = ?) )
        `, [closingDate, closingDate]);
        
        const metrics = metricsRows[0];
        const expectedCash = parseFloat(metrics.total_remitted) - parseFloat(metrics.total_expenses) - parseFloat(metrics.total_withdrawals);
        const difference = actualCash - expectedCash;
        
        // Étape 2: Insérer l'enregistrement de clôture
        const [closingResult] = await connection.execute(`
            INSERT INTO cash_closings (closing_date, expected_cash, actual_cash_counted, difference, comment, closed_by_user_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [closingDate, expectedCash, actualCash, difference, comment, userId]);

        // Étape 3: Vérifier s'il y a des versements en attente pour cette date et les forcer en 'confirmé'
        await connection.execute(`
            UPDATE cash_transactions SET status = 'confirmed', validated_by = ?, validated_at = NOW()
            WHERE type = 'remittance' AND status = 'pending' AND DATE(created_at) = ?
        `, [userId, closingDate]);

        await connection.commit();
        return { closingId: closingResult.insertId, expectedCash, actualCash, difference };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

const findClosingHistory = async (filters = {}) => {
    let query = `
        SELECT cc.*, u.name as closed_by_user_name
        FROM cash_closings cc
        LEFT JOIN users u ON cc.closed_by_user_id = u.id
        WHERE 1=1
    `;
    const params = [];
    if (filters.startDate) {
        query += ' AND cc.closing_date >= ?';
        params.push(filters.startDate);
    }
    if (filters.endDate) {
        query += ' AND cc.closing_date <= ?';
        params.push(filters.endDate);
    }
    query += ' ORDER BY cc.closing_date DESC';
    const [rows] = await dbConnection.execute(query, params);
    return rows;
};

const getCashMetrics = async (startDate, endDate) => {
    const connection = await dbConnection.getConnection();
    try {
        const [transactions] = await connection.execute(`
            SELECT
                COALESCE(SUM(CASE WHEN type = 'remittance' AND status = 'confirmed' THEN amount ELSE 0 END), 0) as total_collected,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END), 0) as total_expenses,
                COALESCE(SUM(CASE WHEN type = 'manual_withdrawal' THEN ABS(amount) ELSE 0 END), 0) as total_withdrawals
            FROM cash_transactions
            WHERE ( (type = 'remittance' AND status = 'confirmed' AND DATE(validated_at) BETWEEN ? AND ?) OR 
                    (type IN ('expense', 'manual_withdrawal') AND DATE(created_at) BETWEEN ? AND ?) )
        `, [startDate, endDate, startDate, endDate]);

        const metrics = transactions[0];
        const cashOnHand = parseFloat(metrics.total_collected) - parseFloat(metrics.total_expenses) - parseFloat(metrics.total_withdrawals);

        return {
            total_collected: metrics.total_collected,
            total_expenses: metrics.total_expenses,
            total_withdrawals: metrics.total_withdrawals,
            cash_on_hand: cashOnHand
        };
    } finally {
        connection.release();
    }
};

module.exports = {
    init, create, update, remove, findAll, getExpenseCategories,
    findRemittanceSummary, findRemittanceDetails, updateRemittanceAmount,
    confirmRemittance, findShortfalls, settleShortfall,
    performCashClosing, findClosingHistory, getCashMetrics
};