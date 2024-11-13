const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const db = new sqlite3.Database('./tienda.db');

app.use(express.json());
app.use(cors());

// Crear las tablas en la base de datos al iniciar
db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS productos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nombre TEXT NOT NULL,
                precio REAL NOT NULL,
                cantidad INTEGER NOT NULL,
                fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            , imagen TEXT, categoria TEXT);
    `);
    db.run(`
    CREATE TABLE IF NOT EXISTS productos_vendidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER,
        cantidad INTEGER,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
        precio REAL,
        costo_total REAL,
        FOREIGN KEY (producto_id) REFERENCES productos(id)
    );
    `);
    db.run(`
    CREATE TABLE IF NOT EXISTS registro_productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER,
        cantidad INTEGER,
        accion TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (producto_id) REFERENCES productos(id)
    );
            `);

});

//Agregar producto
app.post('/api/productos', (req, res) => {
    const { nombre, precio, cantidad, categoria, imagen } = req.body;

    const query = `INSERT INTO productos (nombre, precio, cantidad, categoria, imagen) VALUES (?, ?, ?, ?, ?)`;
    db.run(query, [nombre, precio, cantidad, categoria, imagen], function (err) {
        if (err) {
            return res.status(400).json({ error: 'Error al agregar el producto' });
        }

        // Guardar el registro de la acción
        const registroQuery = `INSERT INTO registro_productos (producto_id, cantidad, accion) VALUES (?, ?, ?)`;
        db.run(registroQuery, [this.lastID, cantidad, 'nuevo producto'], function (err) {
            if (err) {
                console.error('Error al registrar la acción:', err);
                return res.status(500).json({ error: 'Error al registrar la acción' });
            }
            res.json({ message: 'Producto agregado y registrado correctamente', id: this.lastID });
        });
    });
});
//Obtener productos
app.get('/api/productos', (req, res) => {
    const query = 'SELECT * FROM productos';
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('Error al obtener productos:', err);
            return res.status(500).json({ error: 'Error al obtener productos' });
        }
        res.status(200).json(rows);
    });
});
//Obtener ganancias por mes
app.get('/api/ganancias', (req, res) => {
    const mesSeleccionado = req.query.mes;

    if (!mesSeleccionado) {
        return res.status(400).json({ error: 'Mes no proporcionado' });
    }

    db.all(
        `SELECT 
            strftime('%Y-%m', fecha) AS mes, 
            SUM(costo_total) AS ganancias_mensuales
        FROM productos_vendidos 
        WHERE strftime('%Y-%m', fecha) = ? 
        GROUP BY mes`,
        [mesSeleccionado],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Error en la base de datos' });
            }
            const totalGanancias = rows.length > 0 ? rows[0].ganancias_mensuales : 0;
            res.json({ totalGanancias });
        }
    );
});
//Agregar cantidad de un producto existente
app.put('/api/productos/:id', (req, res) => {
    const { id } = req.params;
    const { cantidad } = req.body;

    if (isNaN(cantidad) || cantidad <= 0) {
        return res.status(400).json({ error: 'La cantidad debe ser un número positivo' });
    }

    const query = `UPDATE productos SET cantidad = cantidad + ? WHERE id = ?`;
    db.run(query, [cantidad, id], function (err) {
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        // Guardar el registro de la acción
        const registroQuery = `INSERT INTO registro_productos (producto_id, cantidad, accion) VALUES (?, ?, ?)`;
        db.run(registroQuery, [id, cantidad, 'cantidad agregada'], function (err) {
            if (err) {
                console.error('Error al registrar la acción:', err);
                return res.status(500).json({ error: 'Error al registrar la acción' });
            }
            res.json({ message: 'Cantidad sumada y registrada correctamente', id });
        });
    });
});
//Vender producto
app.post('/api/productos/:id/vender', (req, res) => {
    const { cantidad } = req.body;
    const id = req.params.id; // Tomamos el id del producto desde los parámetros de la ruta

    if (!id || !cantidad) {
        return res.status(400).json({ error: 'ID del producto y cantidad son requeridos' });
    }

    db.get('SELECT * FROM productos WHERE id = ?', [id], (err, producto) => {
        if (err) {
            console.error('Error al obtener el producto:', err);
            return res.status(500).json({ error: 'Error al obtener el producto' });
        }

        if (!producto) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }

        if (producto.cantidad < cantidad) {
            return res.status(400).json({ error: 'No hay suficiente cantidad disponible para la venta' });
        }

        const precioVenta = producto.precio;
        const costoTotal = precioVenta * cantidad;

        db.run(
            'INSERT INTO productos_vendidos (producto_id, cantidad, precio, costo_total) VALUES (?, ?, ?, ?)',
            [id, cantidad, precioVenta, costoTotal],
            function (err) {
                if (err) {
                    console.error('Error al registrar la venta:', err);
                    return res.status(500).json({ error: 'Error al registrar la venta' });
                }

                const nuevaCantidad = producto.cantidad - cantidad;
                db.run('UPDATE productos SET cantidad = ? WHERE id = ?', [nuevaCantidad, id], function (err) {
                    if (err) {
                        console.error('Error al actualizar la cantidad del producto:', err);
                        return res.status(500).json({ error: 'Error al actualizar la cantidad del producto' });
                    }

                    res.status(200).json({
                        message: 'Venta registrada correctamente',
                        costo_total: costoTotal,
                        cantidad_restante: nuevaCantidad
                    });
                });
            }
        );
    });
});
//Obtener órdenes por mes
app.get('/api/ordenes', (req, res) => {
    const mesSeleccionado = req.query.mes; // El mes debe estar en formato 'YYYY-MM'

    if (!mesSeleccionado) {
        return res.status(400).json({ error: 'Mes no proporcionado' });
    }

    db.all(
        `SELECT 
            pv.id AS orden_id,
            pv.fecha,
            pv.cantidad,
            pv.costo_total,
            p.nombre AS nombre_producto
        FROM productos_vendidos pv
        JOIN productos p ON pv.producto_id = p.id
        WHERE strftime('%Y-%m', pv.fecha) = ?
        ORDER BY pv.fecha DESC`,
        [mesSeleccionado],
        (err, rows) => {
            if (err) {
                console.error('Error al obtener las órdenes:', err);
                return res.status(500).json({ error: 'Error en la base de datos' });
            }

            // Regresar los detalles de las órdenes
            res.json({ ordenes: rows });
        }
    );
});

// Ruta para obtener las ganancias diarias
app.get('/api/ganancias/dia', (req, res) => {
    const diaSeleccionado = req.query.dia;

    if (!diaSeleccionado) {
        return res.status(400).json({ error: 'Día no proporcionado' });
    }

    db.all(
        `SELECT 
            strftime('%Y-%m-%d', fecha) AS dia, 
            SUM(costo_total) AS ganancias_diarias
        FROM productos_vendidos 
        WHERE strftime('%Y-%m-%d', fecha) = ? 
        GROUP BY dia`,
        [diaSeleccionado],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Error en la base de datos' });
            }
            const totalGanancias = rows.length > 0 ? rows[0].ganancias_diarias : 0;
            res.json({ totalGanancias });
        }
    );
});

app.get('/api/ordenes/dia', (req, res) => {
    const diaSeleccionado = req.query.dia;
    if (!diaSeleccionado) {
        console.error('Día no proporcionado');
        return res.status(400).json({ error: 'Día no proporcionado' });
    }
    db.all(
        `SELECT 
            id, 
            producto_id,
            cantidad,
            fecha, 
            precio, 
            costo_total 
        FROM productos_vendidos 
        WHERE strftime('%Y-%m-%d', fecha) = ?`,
        [diaSeleccionado],
        (err, rows) => {
            if (err) {
                console.error('Error en la base de datos:', err);
                return res.status(500).json({ error: 'Error en la base de datos' });
            }
            if (rows.length === 0) {
                // En vez de error, enviar una advertencia con código 200
                return res.status(200).json({
                    warning: 'No se encontraron órdenes para la fecha seleccionada.',
                    ordenes: []  // Array vacío de órdenes
                });
            }

            // Si hay órdenes, se devuelven normalmente
            res.json({ ordenes: rows });
        }
    );
});



const PORT = 4000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
