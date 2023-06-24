import * as torch from "../../torch"

class SelfAttention extends torch.nn.Module {

    channels: number;
    size: number;
    mha: torch.nn.MultiheadAttention;
    ln: torch.nn.LayerNorm;
    ff_self: torch.nn.Sequential;

    constructor(channels, size) {
        super();
        this.channels = channels;
        this.size = size;
        this.mha = new torch.nn.MultiheadAttention(channels, 4, );
        this.ln = new torch.nn.LayerNorm([size * size, channels]);
        this.ff_self = new torch.nn.Sequential([
            new torch.nn.LayerNorm([size * size, channels]),
            new torch.nn.Linear(channels, channels),
            new torch.nn.GeLU(),
            new torch.nn.Linear(channels, channels)
        ])
        
    }

    forward(x: torch.Tensor): torch.Tensor {
        x = x.view([-1, this.channels, this.size * this.size]).transpose(1, 2);
        let x_ln = this.ln.forward(x);
        let attention_value = this.mha.forward(x_ln, x_ln, x_ln).output;
        attention_value = torch.add(attention_value, x);
        attention_value = torch.add(this.ff_self.forward(attention_value), attention_value);
        return attention_value.transpose(2, 1).view([-1, this.channels, this.size, this.size]);

    }
}

class DoubleConv extends torch.nn.Module {

    residual: boolean;
    double_conv: torch.nn.Sequential;

    constructor(in_channels: number, out_channels: number, mid_channels=NaN, residual=false) {
        super();
        this.residual = residual;
        if (isNaN(mid_channels)) {
            mid_channels = out_channels;
        }
        this.double_conv = new torch.nn.Sequential([
            new torch.nn.Conv2d(in_channels, mid_channels, 3, 1, 1, 1, 1, false),
            new torch.nn.GroupNorm(1, mid_channels),
            new torch.nn.GeLU(),
            new torch.nn.Conv2d(mid_channels, out_channels, 3, 1, 1, 1, 1, false),
            new torch.nn.GroupNorm(1, out_channels)
        ])
    }

    forward(x) {
        if (this.residual) {
            return torch.gelu(torch.add(x, this.double_conv.forward(x)));
        } else {
            return this.double_conv.forward(x);
        }
    }
}

class Down extends torch.nn.Module {

    maxpool_conv: torch.nn.Sequential;
    emb_layer: torch.nn.Sequential;

    constructor(in_channels: number, out_channels: number, emb_dim=256) {
        super();
        this.maxpool_conv = new torch.nn.Sequential([
            new torch.nn.MaxPool2d(2),
            new DoubleConv(in_channels, in_channels, undefined, true),
            new DoubleConv(in_channels, out_channels)
        ]);

        this.emb_layer = new torch.nn.Sequential([
            new torch.nn.SiLU(),
            new torch.nn.Linear(
                emb_dim,
                out_channels
            )
        ])
    }

    forward(x: torch.Tensor, t: torch.Tensor): torch.Tensor {
        x = this.maxpool_conv.forward(x);
        //x shape: torch.Size([{batch_size}, 128, 32, 32])
        t = this.emb_layer.forward(t);
        //t shape: torch.Size([{batch_size}, 128, 32, 32])
        const emb = torch.repeat(t, [1, 1, x.shape[x.shape.length-2], x.shape[x.shape.length-1]]);
        return torch.add(x, emb);
    }
}

class Up extends torch.nn.Module {

    up: torch.nn.UpSample;
    conv: torch.nn.Sequential;
    emb_layer: torch.nn.Sequential;

    constructor(in_channels: number, out_channels: number, emb_dim=256) {
        super();

        this.up = new torch.nn.UpSample(null, 20, "bilinear");
        this.conv = new torch.nn.Sequential([
            new DoubleConv(in_channels, in_channels, undefined, true),
            new DoubleConv(in_channels, out_channels, Math.floor(in_channels / 2)),
        ])

        this.emb_layer = new torch.nn.Sequential([
            new torch.nn.SiLU(),
            new torch.nn.Linear(emb_dim, out_channels),
        ])
    }

    forward(x, skip_x, t) {
        x = this.up.forward(x);
        x = torch.cat(skip_x, x, 1);
        x = this.conv.forward(x);
        t = this.emb_layer.forward(t);
        let emb = torch.repeat(t, [1, 1, x.shape[x.shape.length-2], x.shape[x.shape.length-1]]);
        return torch.add(x, emb);
    }
}


export class UNet extends torch.nn.Module {
    time_dim: number;

    inc: DoubleConv;
    down1: Down;
    sa1: SelfAttention;
    down2: Down;
    sa2: SelfAttention;
    down3: Down;
    sa3: SelfAttention;

    bot1: DoubleConv;
    bot2: DoubleConv;
    bot3: DoubleConv;

    up1: Up;
    sa4: SelfAttention;
    up2: Up;
    sa5: SelfAttention;
    up3: Up;
    sa6: SelfAttention;
    outc: torch.nn.Conv2d;

    constructor(c_in=3, c_out=3, time_dim=256) {
        super();
        this.time_dim = time_dim;
        this.inc = new DoubleConv(c_in, 64);
        this.down1 = new Down(64, 128);
        this.sa1 = new SelfAttention(128, 32);
        this.down2 = new Down(128, 256);
        this.sa2 = new SelfAttention(256, 16);
        this.down3 = new Down(256, 256);
        this.sa3 = new SelfAttention(256, 8);

        this.bot1 = new DoubleConv(256, 512);
        this.bot2 = new DoubleConv(512, 512);
        this.bot3 = new DoubleConv(512, 256);

        this.up1 = new Up(512, 128);
        this.sa4 = new SelfAttention(128, 16);
        this.up2 = new Up(256, 64);
        this.sa5 = new SelfAttention(64, 32);
        this.up3 = new Up(128, 64);
        this.sa6 = new SelfAttention(64, 64);
        this.outc = new torch.nn.Conv2d(64, c_out, 1, 1, 0, null, 1, false);
    }

    pos_encoding(t: torch.Tensor, channels: number) {
        const range = torch.scalar_div(torch.arange(0, channels, 2), channels);
        const inv_freq = torch.div(torch.ones(range.shape), torch.pow(torch.constant(range.shape, 10000), range)).unsqueeze(0);
        const pos_enc_a = torch.sin(torch.mul(torch.repeat(t, [1, Math.floor(channels / 2)]), inv_freq));
        const pos_enc_b = torch.cos(torch.mul(torch.repeat(t, [1, Math.floor(channels / 2)]), inv_freq));
        const pos_enc = torch.cat(pos_enc_a, pos_enc_b, 1);
        return pos_enc;
    }

    forward(x: torch.Tensor, t: torch.Tensor) {
        let status = 0;
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x, "forwarding x")
        _log_tensor(t, "with t")
        t = torch.unsqueeze(t, -1);
        t = this.pos_encoding(t, this.time_dim);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(t, "pos_encoding");

        console.log("finsihed pos_encoding starting down");

        let x1 = this.inc.forward(x);
        _log_tensor(x1, "inc");
        console.log(`forwarding... step: ${status}`);
        status++;
        
        let x2 = this.down1.forward(x1, t);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x2, "down1");
        x2 = this.sa1.forward(x2);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x2, "sa1");
        let x3 = this.down2.forward(x2, t);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x3, "down2");
        x3 = this.sa2.forward(x3);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x3, "sa2")
        let x4 = this.down3.forward(x3, t);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x4, "down3");
        x4 = this.sa3.forward(x4);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x4, "sa3");

        console.log("finsihed down starting bot");
        x4 = this.bot1.forward(x4);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x4, "bot1");
        x4 = this.bot2.forward(x4);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x4, "bot2");
        x4 = this.bot3.forward(x4);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x4, "bot3");

        console.log("finsihed bot starting up");
        x = this.up1.forward(x4, x3, t);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x, "up1");
        x = this.sa4.forward(x);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x, "sa4");
        x = this.up2.forward(x, x2, t);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x, "up2");
        x = this.sa5.forward(x);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x, "sa5")
        x = this.up3.forward(x, x1, t);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x, "up3");
        x = this.sa6.forward(x);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(x, "sa6")

        const output = this.outc.forward(x);
        console.log(`forwarding... step: ${status}`);
        status++;
        _log_tensor(output, "finished UNet")
        return output

    }
}

async function _log_tensor(x: torch.Tensor, message?: string) {
    const data = await x.toArrayAsync();
    console.log(message ? message : "", data);
}